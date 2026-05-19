/**
 * pi-python — exposes a persistent Python execution environment to the agent.
 *
 * Tools registered:
 *   - python                : execute one or more Python cells in a long-lived kernel
 *   - python_set_interpreter : switch the kernel to a different python binary
 *
 * Slash commands:
 *   - /python-status  : kernel info + checkpoint stats (count, disk usage, latest)
 *   - /python-restart : kill and respawn the kernel; restores the latest
 *                       on-disk checkpoint so namespace state up through the
 *                       last successful cell is preserved. Use when a cell
 *                       hangs or the kernel is wedged.
 *
 * CLI flags:
 *   --python <path>   : override the interpreter used for new kernels
 *
 * State preservation:
 *   After every successful `python` tool call the runner pickles the
 *   namespace to ~/.pi/pi-python/<sessionId>/<leafId>.pkl. On the next
 *   kernel spawn (cold start, /python-restart, after /tree navigation) the
 *   pickle for the current leaf is restored automatically. dill is used
 *   when importable, stdlib pickle as a fallback. Checkpoints over 256 MB
 *   are silently skipped; see /python-status for details.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * The subset of SessionManager methods the extension actually consumes.
 * Sourced from ExtensionContext so we don't depend on a non-public type
 * symbol; lets us call resolveRestorePath() from tests without having to
 * fabricate the rest of an ExtensionContext.
 */
type SessionManagerView = ExtensionContext["sessionManager"];
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	highlightCode,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
	type CellRequest,
	type ExecuteResult,
	PythonKernel,
	resolvePythonPath,
	validateInterpreterPath,
	verifyInterpreterRuns,
} from "./kernel.ts";
import { loadSettings, PI_PYTHON_DIR } from "./settings.ts";

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 600;

const CHECKPOINT_ROOT = PI_PYTHON_DIR;
const MAX_PICKLES_PER_SESSION = 20;

interface CheckpointInfo {
	leafId: string;
	bytes: number;
	durationMs: number;
	keysPicked: number;
	keysSkipped: number;
	skippedNames: string[];
	ts: number;
}

export default function pythonExtension(pi: ExtensionAPI) {
	let kernel: PythonKernel | null = null;
	// Active explicit interpreter override. Sourced from --python at startup
	// and updatable at runtime via the python_set_interpreter tool.
	let pythonOverride: string | null = null;
	// Stats for /python-status — last successful checkpoint, leaves we're
	// not retrying because they exceeded thresholds, last restore outcome.
	let lastCheckpoint: CheckpointInfo | null = null;
	let lastRestore:
		| {
				leafId: string;
				keysRestored: number;
				keysFailed: number;
				durationMs: number;
				ts: number;
		  }
		| null = null;
	// Records the most recent fork-inheritance copy (parent session id +
	// number of pickles inherited). Surfaced in /python-status so users can
	// confirm a fresh fork picked up the parent's checkpoints.
	let lastInherit:
		| {
				parentSessionId: string;
				copied: number;
				ts: number;
		  }
		| null = null;
	const skippedLeaves = new Set<string>();

	pi.registerFlag("python", {
		description: "Path to the Python interpreter pi-python should use",
		type: "string",
	});

	const ensureKernel = async (
		cwd: string,
		restorePicklePath: string | null,
	): Promise<PythonKernel> => {
		if (kernel?.isAlive()) return kernel;
		// Drop any dead reference before spawning a new one.
		if (kernel) {
			try {
				await kernel.shutdown();
			} catch {
				// ignore
			}
			kernel = null;
		}
		const { values: settings } = loadSettings({ cwd });
		const pythonPath = resolvePythonPath({
			override: pythonOverride,
			cwd,
			walkParents: settings.venvParentWalk,
			venvDirNames: settings.venvDirNames,
		});
		const next = new PythonKernel({ pythonPath, cwd });
		await next.start();
		kernel = next;

		// Lazy restore: if the current leaf has a checkpoint on disk, load it
		// so the new process picks up where the dead one left off.
		if (restorePicklePath && existsSync(restorePicklePath)) {
			try {
				const result = await next.restore(restorePicklePath);
				if (result.ok) {
					lastRestore = {
						leafId: leafIdFromPicklePath(restorePicklePath),
						keysRestored: result.keysRestored,
						keysFailed: result.keysFailed,
						durationMs: result.durationMs,
						ts: Date.now(),
					};
				}
			} catch {
				// Restore is best-effort; an empty namespace is acceptable.
			}
		}
		return next;
	};

	const killKernel = async (): Promise<void> => {
		if (!kernel) return;
		try {
			await kernel.shutdown();
		} catch {
			kernel.kill();
		}
		kernel = null;
	};

	const restorePathFor = (ctx: ExtensionContext): string | null =>
		resolveRestorePath(ctx.sessionManager);

	const maybeCheckpoint = async (ctx: ExtensionContext): Promise<void> => {
		if (!kernel?.isAlive()) return;
		if (!ctx.sessionManager.getSessionFile()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const leafId = ctx.sessionManager.getLeafId();
		if (!sessionId || !leafId) return;
		if (skippedLeaves.has(leafId)) return;

		const path = picklePathFor(sessionId, leafId);
		const { values: settings } = loadSettings({ cwd: ctx.cwd });
		try {
			mkdirSync(checkpointDirFor(sessionId), { recursive: true });
			const result = await kernel.checkpoint(path, settings.pickleMaxBytes);
			if (result.ok) {
				lastCheckpoint = {
					leafId,
					bytes: result.bytes,
					durationMs: result.durationMs,
					keysPicked: result.keysPicked,
					keysSkipped: result.keysSkipped,
					skippedNames: result.skippedNames,
					ts: Date.now(),
				};
				// Prune old, non-branch checkpoints to keep the dir bounded.
				const branchIds = new Set(ctx.sessionManager.getBranch().map((e) => e.id));
				pruneCheckpoints(sessionId, branchIds, MAX_PICKLES_PER_SESSION);
			} else if (result.skipped) {
				// Don't retry this leaf until the kernel restarts. Big-DataFrame
				// users see this once per leaf, not on every cell.
				skippedLeaves.add(leafId);
			}
		} catch {
			// Checkpointing is best-effort — never fail a cell because we
			// couldn't snapshot.
		}
	};

	pi.registerTool({
		name: "python",
		label: "Python",
		// Two python cells can't usefully run concurrently against the same
		// kernel — the runner only handles one execute at a time and a parallel
		// call would just throw. Force the agent loop to serialize them.
		executionMode: "sequential",
		description:
			"Execute Python code in a persistent interpreter session. " +
			"Variables, imports, and definitions persist across calls in the same session, " +
			"and are automatically checkpointed to disk so kernel restarts don't lose state. " +
			"Cells run sequentially; if a cell raises, later cells are skipped. " +
			`Default timeout is ${DEFAULT_TIMEOUT_S}s (max ${MAX_TIMEOUT_S}s); pass a higher \`timeout\` ` +
			"for long-running work. Use cells: [{code: '...'}].",
		promptSnippet:
			"Run Python code in a persistent kernel for data wrangling, math, and parsing",
		promptGuidelines: [
			"Use python for non-trivial data transforms, JSON/CSV parsing, math, and stateful scratch work.",
			"Use python with multiple cells when you want to inspect intermediate results without rerunning earlier setup.",
			"Pass python's `timeout` parameter (in seconds, up to 600) for long-running work like training, large IO, or expensive aggregations — the default of 120s is tuned for interactive scratch work.",
		],
		parameters: Type.Object({
			cells: Type.Array(
				Type.Object({
					code: Type.String({
						description: "Python source for this cell. Last expression's value is shown.",
					}),
					title: Type.Optional(
						Type.String({ description: "Optional short label for this cell." }),
					),
				}),
				{ minItems: 1, description: "Cells to execute, sequentially." },
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Wall-clock timeout in seconds for the whole call. Defaults to ${DEFAULT_TIMEOUT_S}s, clamped to ${MIN_TIMEOUT_S}-${MAX_TIMEOUT_S}.`,
				}),
			),
			reset: Type.Optional(
				Type.Boolean({
					description:
						"If true, discard the existing kernel namespace before running the first cell.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the kernel. Falls back to pi's cwd. Persists for future calls.",
				}),
			),
		}),
		renderCall(args, theme, _context) {
			const cells = Array.isArray(args?.cells) ? args.cells : [];
			const lines: string[] = [];

			const header: string[] = [theme.fg("toolTitle", theme.bold("python"))];
			if (args?.reset) header.push(theme.fg("warning", "reset"));
			if (cells.length > 1) header.push(theme.fg("muted", `${cells.length} cells`));
			else if (cells.length === 1 && cells[0]?.title) {
				header.push(theme.fg("muted", `· ${cells[0].title}`));
			}
			if (args?.timeout) header.push(theme.fg("dim", `timeout=${args.timeout}s`));
			if (args?.cwd) header.push(theme.fg("dim", `cwd=${args.cwd}`));
			lines.push(header.join(" "));

			if (cells.length === 0) return new Text(lines.join("\n"), 0, 0);

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i] ?? {};
				const code = typeof cell.code === "string" ? cell.code : "";

				if (cells.length > 1) {
					const title = cell.title ? `: ${cell.title}` : "";
					lines.push(theme.fg("muted", `── cell ${i + 1}/${cells.length}${title} ──`));
				}

				if (!code) {
					lines.push(theme.fg("dim", "(empty)"));
					continue;
				}
				try {
					lines.push(...highlightCode(code, "python"));
				} catch {
					lines.push(...code.split("\n"));
				}
			}

			return new Text(lines.join("\n"), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = resolveCwd(params.cwd, ctx.cwd);
			const cells: CellRequest[] = params.cells.map(
				(c: { code: string; title?: string }) => ({
					code: c.code,
					title: c.title,
				}),
			);
			const timeoutS = clampTimeout(params.timeout);

			const k = await ensureKernel(cwd, restorePathFor(ctx));

			const result = await k.execute(cells, {
				timeoutMs: timeoutS * 1000,
				reset: params.reset,
				cwd,
				signal,
				onUpdate: (snapshot) => {
					onUpdate?.({
						content: [{ type: "text", text: formatExecuteResult(cells, snapshot, true) }],
						details: { snapshot, partial: true },
					});
				},
			});

			const text = formatExecuteResult(cells, result, false);
			const info = k.getInfo();
			return {
				content: [{ type: "text", text }],
				details: {
					cells: result.cells,
					cancelled: result.cancelled,
					timedOut: result.timedOut,
					reset: result.reset,
					cellsRun: result.cellsRun,
					python: info?.python,
					executable: info?.executable,
					pid: info?.pid,
					cwd,
				},
			};
		},
	});

	pi.registerTool({
		name: "python_set_interpreter",
		label: "Python Set Interpreter",
		// Switching mid-execution would silently interrupt a running python
		// cell — almost never what the model intends. Wait our turn.
		executionMode: "sequential",
		description:
			"Switch the persistent Python kernel to a different interpreter binary. " +
			"Pass an absolute path to a python executable (e.g. /path/to/.venv/bin/python or /usr/bin/python3.12), " +
			"or a bare command name on PATH (e.g. python3.12). The current kernel is killed and a new one is started immediately, " +
			"so all in-memory variables, imports, and definitions are discarded — checkpoints are NOT restored across an interpreter switch " +
			"because pickled objects from one venv typically can't load into another. Use this to access libraries installed in a specific venv.",
		promptSnippet:
			"Switch the persistent Python kernel to a specific interpreter binary (e.g. a venv's python) to access different installed libraries",
		promptGuidelines: [
			"Use python_set_interpreter when the user asks for a specific Python version or wants libraries from a particular venv. The path must point at the python binary itself (e.g. <venv>/bin/python), not the venv directory.",
			"After python_set_interpreter, the kernel namespace is empty and on-disk checkpoints are not restored — re-import anything you need before continuing.",
		],
		parameters: Type.Object({
			path: Type.String({
				description:
					"Path to a python interpreter binary, or a bare command name resolvable on PATH. Directories are rejected.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let validated: string;
			try {
				validated = validateInterpreterPath(params.path);
			} catch (err) {
				throw err instanceof Error ? err : new Error(String(err));
			}

			const previous = kernel?.getInfo() ?? null;
			const previousOverride = pythonOverride;

			await killKernel();
			pythonOverride = validated;
			// Skipped-leaf decisions are scoped to a kernel process, so reset
			// them whenever we switch interpreters.
			skippedLeaves.clear();

			try {
				// Skip restore: cross-interpreter unpickling is unsafe.
				const k = await ensureKernel(ctx.cwd, null);
				const info = k.getInfo();
				const pythonLine = info?.python.split("\n")[0] ?? "unknown";
				const lines = [
					`Switched python interpreter.`,
					`  requested: ${params.path}`,
					`  resolved:  ${validated}`,
					`  executable: ${info?.executable ?? validated}`,
					`  version: ${pythonLine}`,
					`  pid: ${info?.pid ?? "?"}`,
				];
				if (previous) {
					lines.push(
						`Previous kernel (pid ${previous.pid}, ${previous.executable}) was discarded; ` +
							`namespace is fresh (no checkpoint restored).`,
					);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						requested: params.path,
						resolved: validated,
						executable: info?.executable ?? validated,
						python: info?.python ?? "",
						pid: info?.pid ?? null,
						cwd: info?.cwd ?? ctx.cwd,
						previous,
					},
				};
			} catch (err) {
				pythonOverride = previousOverride;
				throw new Error(
					`Failed to start kernel with ${validated}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	pi.registerCommand("python-status", {
		description: "Show pi-python kernel and checkpoint status",
		handler: async (_args, ctx) => {
			const lines: string[] = ["pi-python kernel"];
			if (kernel) {
				const info = kernel.getInfo();
				if (info) {
					lines.push(`  executable: ${info.executable}`);
					lines.push(`  python:     ${info.python.split("\n")[0]}`);
					lines.push(`  pid:        ${info.pid}`);
					lines.push(`  cwd:        ${info.cwd}`);
					lines.push(`  alive:      ${kernel.isAlive() ? "yes" : "no"}`);
					lines.push(`  pickler:    ${kernel.getPickler() ?? "?"}`);
				} else {
					lines.push("  starting...");
				}
			} else {
				lines.push("  no kernel running (lazy spawn on first use)");
			}

			const { values: settings, sources, paths, warnings } = loadSettings({ cwd: ctx.cwd });

			lines.push("");
			lines.push("settings");
			lines.push(`  global file:  ${paths.global}${existsSync(paths.global) ? "" : " (absent)"}`);
			if (paths.project) {
				lines.push(
					`  project file: ${paths.project}${existsSync(paths.project) ? "" : " (absent)"}`,
				);
			}
			lines.push(
				`  pickleMaxBytes: ${formatSize(settings.pickleMaxBytes)} ` +
					`(${settings.pickleMaxBytes} bytes, source: ${sources.pickleMaxBytes})`,
			);
			for (const w of warnings) lines.push(`  warning: ${w}`);

			lines.push("");
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId || !ctx.sessionManager.getSessionFile()) {
				lines.push("checkpoints: disabled (in-memory session)");
			} else {
				const all = listCheckpoints(sessionId);
				const totalBytes = all.reduce((s, c) => s + c.size, 0);
				lines.push(`checkpoints (${checkpointDirFor(sessionId)})`);
				lines.push(`  count:      ${all.length} / ${MAX_PICKLES_PER_SESSION} max per session`);
				lines.push(`  total size: ${formatSize(totalBytes)}`);

				if (lastCheckpoint) {
					const ageS = Math.max(0, Math.round((Date.now() - lastCheckpoint.ts) / 1000));
					const skipNames =
						lastCheckpoint.skippedNames.length > 0
							? ` (skipped: ${lastCheckpoint.skippedNames.slice(0, 4).join(", ")}${
									lastCheckpoint.skippedNames.length > 4 ? "…" : ""
								})`
							: "";
					lines.push(
						`  latest:     ${lastCheckpoint.leafId.slice(0, 8)} — ${formatSize(lastCheckpoint.bytes)}, ` +
							`${ageS}s ago, ${lastCheckpoint.keysPicked} keys${skipNames}`,
					);
				} else {
					lines.push("  latest:     (none yet this session)");
				}

				if (lastRestore) {
					const ageS = Math.max(0, Math.round((Date.now() - lastRestore.ts) / 1000));
					lines.push(
						`  restored:   ${lastRestore.leafId.slice(0, 8)} — ` +
							`${lastRestore.keysRestored} keys, ${ageS}s ago` +
							(lastRestore.keysFailed > 0 ? ` (${lastRestore.keysFailed} failed)` : ""),
					);
				}

				if (lastInherit) {
					const ageS = Math.max(0, Math.round((Date.now() - lastInherit.ts) / 1000));
					lines.push(
						`  inherited:  ${lastInherit.copied} from parent ${lastInherit.parentSessionId.slice(0, 8)}, ${ageS}s ago`,
					);
				}

				const leafId = ctx.sessionManager.getLeafId();
				if (leafId) {
					const leafPath = picklePathFor(sessionId, leafId);
					const leafHasOwn = existsSync(leafPath);
					lines.push(
						`  active leaf: ${leafId.slice(0, 8)} ${
							leafHasOwn ? "✓ checkpoint present" : "✗ no checkpoint"
						}`,
					);
					// When the active leaf has no checkpoint of its own, the
					// branch-walk lookup will still find an ancestor pickle. Show
					// the user which one would actually be loaded so the line above
					// isn't misleading after /tree navigation.
					if (!leafHasOwn) {
						const resolved = restorePathFor(ctx);
						if (resolved) {
							const ancestor = leafIdFromPicklePath(resolved);
							lines.push(
								`  restore src: ${ancestor.slice(0, 8)} (↑ nearest ancestor on branch)`,
							);
						} else {
							lines.push(`  restore src: (none on branch — fresh namespace)`);
						}
					}
				}

				const branchIds = new Set(ctx.sessionManager.getBranch().map((e) => e.id));
				const onBranch = all.filter((c) => branchIds.has(c.leafId)).length;
				lines.push(
					`  branch:     ${onBranch} checkpoint${onBranch === 1 ? "" : "s"} on active path`,
				);

				if (skippedLeaves.size > 0) {
					lines.push(
						`  skipped:    ${skippedLeaves.size} leaf${skippedLeaves.size === 1 ? "" : "s"} ` +
							`exceeded ${formatSize(settings.pickleMaxBytes)} threshold (won't retry until restart)`,
					);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("python-restart", {
		description:
			"Restart the pi-python kernel; preserves namespace via the latest on-disk checkpoint",
		handler: async (_args, ctx) => {
			if (kernel) {
				const info = kernel.getInfo();
				const ok = await ctx.ui.confirm(
					"Restart Python kernel?",
					`This kills ${info ? `pid ${info.pid}` : "the current kernel"} ` +
						`(interrupting any hung cell) and respawns it. The latest on-disk ` +
						`checkpoint for the current branch leaf will be restored, so ` +
						`variables produced by previously-completed cells survive. ` +
						`Anything written purely in-memory since the last successful cell is lost.`,
				);
				if (!ok) return;
				try {
					kernel.interrupt();
				} catch {
					// ignore
				}
				try {
					kernel.kill();
				} catch {
					// ignore
				}
				kernel = null;
			}
			skippedLeaves.clear();

			try {
				const restorePath = restorePathFor(ctx);
				const hadPickle = restorePath !== null && existsSync(restorePath);
				const k = await ensureKernel(ctx.cwd, restorePath);
				const info = k.getInfo();
				const detail = hadPickle
					? lastRestore
						? `; restored ${lastRestore.keysRestored} keys`
						: "; checkpoint present but restore reported no keys"
					: "; no checkpoint to restore (fresh namespace)";
				ctx.ui.notify(
					`pi-python: kernel restarted (pid ${info?.pid ?? "?"})${detail}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`pi-python: restart failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// Fork inheritance: when this session was forked from another, copy the
	// parent's per-leaf checkpoint pickles into this session's dir for any
	// entry id on the active branch. Because /fork preserves entry ids
	// verbatim (see SessionManager.forkFrom and createBranchedSession), a
	// pickle keyed by entry id X in the parent is a valid pickle for entry
	// id X in the fork. The branch-walk lookup then resolves to it on the
	// next ensureKernel(), exactly like a non-forked session would.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "fork") return;
		const result = inheritParentCheckpoints(ctx.sessionManager);
		if (!result) return;
		lastInherit = {
			parentSessionId: result.parentSessionId,
			copied: result.copied,
			ts: Date.now(),
		};
		if (result.copied > 0) {
			ctx.ui.notify(
				`pi-python: inherited ${result.copied} checkpoint${result.copied === 1 ? "" : "s"} ` +
					`from parent session ${result.parentSessionId.slice(0, 8)}`,
				"info",
			);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const flagValue = pi.getFlag("python") as string | undefined;
		if (!flagValue) return;

		let validated: string;
		try {
			validated = validateInterpreterPath(flagValue);
		} catch (err) {
			ctx.ui.notify(
				`pi-python: --python ${flagValue} rejected: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}

		// Smoke-test the interpreter so a typo in --python (especially a bare
		// command name that doesn't exist on PATH) is caught before the first
		// agent call rather than as a confusing tool error.
		const check = verifyInterpreterRuns(validated);
		if (!check.ok) {
			ctx.ui.notify(
				`pi-python: --python ${flagValue} cannot run: ${check.error}. Falling back to default interpreter resolution.`,
				"error",
			);
			return;
		}

		pythonOverride = validated;
		ctx.ui.notify(
			`pi-python: interpreter override -> ${validated}` +
				(check.version ? ` (${check.version})` : ""),
			"info",
		);
	});

	// Checkpoint after every successful python tool result. message_end fires
	// after the toolResult has been written to the session, so getLeafId()
	// returns the toolResult's id, which is exactly the key we want.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "toolResult") return;
		if (message.toolName !== "python") return;
		if (message.isError) return;
		await maybeCheckpoint(ctx);
	});

	// /tree navigation: kill the current kernel so we don't keep state from
	// the old branch. If the new branch has a checkpoint reachable on its
	// ancestry, eagerly respawn + restore so the next agent `python` call
	// doesn't pay Python startup + unpickle latency, and any restore
	// failure surfaces in /python-status immediately rather than mid-tool.
	// When there's nothing to restore we stay lazy — no point paying Python
	// startup cost for an empty namespace.
	pi.on("session_tree", async (_event, ctx) => {
		await killKernel();
		// skippedLeaves is keyed by leafId within a single kernel process;
		// after a kill+respawn old entries are stale.
		skippedLeaves.clear();
		const restorePath = restorePathFor(ctx);
		if (!restorePath) return;
		try {
			await ensureKernel(ctx.cwd, restorePath);
		} catch {
			// Best-effort. The next agent `python` call will retry through
			// ensureKernel() and surface any persistent failure there.
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Opportunistic flush in case a cell completed but the message_end
		// checkpoint never fired (e.g. abrupt /quit during streaming).
		try {
			await maybeCheckpoint(ctx);
		} catch {
			// ignore
		}
		await killKernel();
	});
}

// ─── helpers (module scope) ─────────────────────────────────────────────────

function clampTimeout(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_S;
	return Math.min(Math.max(value, MIN_TIMEOUT_S), MAX_TIMEOUT_S);
}

function resolveCwd(requested: string | undefined, fallback: string): string {
	if (!requested) return fallback;
	const abs = resolve(fallback, requested);
	if (!existsSync(abs) || !statSync(abs).isDirectory()) {
		return abs;
	}
	return abs;
}

export function checkpointDirFor(sessionId: string): string {
	return join(CHECKPOINT_ROOT, sessionId);
}

export function picklePathFor(sessionId: string, leafId: string): string {
	return join(checkpointDirFor(sessionId), `${leafId}.pkl`);
}

/**
 * Walk the session's active branch from leaf back to root and return the
 * first ancestor whose checkpoint pickle exists on disk, or `null` if no
 * ancestor is checkpointed (or the session isn't being persisted).
 *
 * Exported so tests can drive it against a real SessionManager without
 * having to assemble a full ExtensionContext.
 *
 * Why branch-walk instead of exact-leaf match: pickles are keyed by python
 * toolResult message id, but the active leaf after `/tree` navigation is
 * almost always some other entry (an assistant or user message somewhere
 * on the branch). Walking the branch finds the most recent python
 * checkpoint reachable from the new leaf.
 */
export function resolveRestorePath(
	sessionManager: SessionManagerView,
): string | null {
	if (!sessionManager.getSessionFile()) return null;
	const sessionId = sessionManager.getSessionId();
	if (!sessionId) return null;
	const branch = sessionManager.getBranch();
	// getBranch() returns root → leaf; iterate in reverse so we pick the
	// deepest ancestor that has a checkpoint.
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry?.id) continue;
		const path = picklePathFor(sessionId, entry.id);
		if (existsSync(path)) return path;
	}
	return null;
}

/** Read just the session id out of a session file's header line. Returns
 * null if the file is missing, empty, or doesn't start with a valid
 * session header. Cheap — reads only the first line. */
export function readSessionIdFromFile(filePath: string): string | null {
	let content: string;
	try {
		content = readFileSync(filePath, { encoding: "utf8" });
	} catch {
		return null;
	}
	const firstLine = content.split("\n", 1)[0];
	if (!firstLine) return null;
	try {
		const obj = JSON.parse(firstLine) as { type?: string; id?: string };
		if (obj.type !== "session") return null;
		return typeof obj.id === "string" ? obj.id : null;
	} catch {
		return null;
	}
}

/**
 * Copy any parent-session pickles whose leaf id appears on the new (fork)
 * session's active branch into the new session's checkpoint dir.
 *
 * Safe to call on every session_start — returns null if there's no parent
 * to inherit from. Existing pickles in the destination are never
 * overwritten, so a re-run of this function (e.g. after `/python-status`)
 * is idempotent.
 *
 * Returns the parent session id and number of pickles actually copied, or
 * null if no inheritance was attempted (no parent, parent file missing,
 * etc.). Exported for testing.
 */
export function inheritParentCheckpoints(
	sessionManager: SessionManagerView,
): { parentSessionId: string; copied: number } | null {
	const newSessionId = sessionManager.getSessionId();
	if (!newSessionId) return null;
	const header = sessionManager.getHeader();
	const parentPath = header?.parentSession;
	if (!parentPath) return null;
	const parentSessionId = readSessionIdFromFile(parentPath);
	if (!parentSessionId || parentSessionId === newSessionId) return null;
	const parentDir = checkpointDirFor(parentSessionId);
	if (!existsSync(parentDir)) return { parentSessionId, copied: 0 };

	const branch = sessionManager.getBranch();
	const newDir = checkpointDirFor(newSessionId);
	let copied = 0;
	for (const entry of branch) {
		if (!entry?.id) continue;
		const parentPickle = picklePathFor(parentSessionId, entry.id);
		if (!existsSync(parentPickle)) continue;
		const targetPickle = picklePathFor(newSessionId, entry.id);
		if (existsSync(targetPickle)) continue; // never clobber
		if (copied === 0) mkdirSync(newDir, { recursive: true });
		try {
			copyFileSync(parentPickle, targetPickle);
			copied++;
		} catch {
			// best-effort — a single failed copy shouldn't block the others
		}
	}
	return { parentSessionId, copied };
}

function leafIdFromPicklePath(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? "";
	return base.endsWith(".pkl") ? base.slice(0, -4) : base;
}

interface CheckpointFile {
	leafId: string;
	path: string;
	size: number;
	mtime: number;
}

function listCheckpoints(sessionId: string): CheckpointFile[] {
	const dir = checkpointDirFor(sessionId);
	if (!existsSync(dir)) return [];
	const result: CheckpointFile[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".pkl")) continue;
		const path = join(dir, name);
		try {
			const s = statSync(path);
			if (!s.isFile()) continue;
			result.push({
				leafId: name.slice(0, -4),
				path,
				size: s.size,
				mtime: s.mtimeMs,
			});
		} catch {
			// race with concurrent prune; skip
		}
	}
	return result;
}

/**
 * Keep all `keepLeafIds` (active branch) plus the most-recently-modified
 * checkpoints up to `maxCount`. Evict the rest. Returns the number removed.
 */
function pruneCheckpoints(
	sessionId: string,
	keepLeafIds: Set<string>,
	maxCount: number,
): number {
	const all = listCheckpoints(sessionId);
	if (all.length <= maxCount) return 0;
	all.sort((a, b) => b.mtime - a.mtime); // newest first
	const kept = new Set<string>();
	for (const item of all) if (keepLeafIds.has(item.leafId)) kept.add(item.leafId);
	for (const item of all) {
		if (kept.size >= maxCount) break;
		kept.add(item.leafId);
	}
	let removed = 0;
	for (const item of all) {
		if (kept.has(item.leafId)) continue;
		try {
			unlinkSync(item.path);
			removed++;
		} catch {
			// ignore
		}
	}
	return removed;
}

function formatExecuteResult(
	requested: CellRequest[],
	result: ExecuteResult,
	partial: boolean,
): string {
	const sections: string[] = [];
	const total = requested.length;
	const ranCount = result.cells.length;

	for (let i = 0; i < total; i++) {
		const cell = result.cells[i];
		const requestedCell = requested[i];
		const title = requestedCell.title ? ` ${requestedCell.title}` : "";
		const heading = `── cell ${i + 1}/${total}${title} ──`;

		if (!cell || (!cell.ok && !cell.exception && !cell.stdout && !cell.stderr && !partial)) {
			if (cell || partial) {
				sections.push(`${heading}\n[not run]`);
			}
			continue;
		}

		const parts: string[] = [heading];
		if (cell.stdout) parts.push(formatStream("stdout", cell.stdout));
		if (cell.stderr) parts.push(formatStream("stderr", cell.stderr));
		if (cell.ok && cell.value) parts.push(`=> ${cell.value}`);
		if (!cell.ok && cell.exception) parts.push(cell.exception.trimEnd());
		if (partial && !cell.ok && !cell.exception && i === ranCount - 1) {
			parts.push("[running...]");
		}

		sections.push(parts.join("\n"));
	}

	const lines: string[] = [];
	if (result.reset) lines.push("[kernel reset]");
	if (result.timedOut) lines.push(`[timed out]`);
	else if (result.cancelled) lines.push("[cancelled]");
	if (lines.length > 0) sections.unshift(lines.join(" "));

	const body = sections.join("\n\n").trimEnd();
	return truncateForLLM(body || "[no output]");
}

function formatStream(label: "stdout" | "stderr", data: string): string {
	const trimmed = data.replace(/\n+$/, "");
	if (!trimmed.includes("\n")) return `${label}: ${trimmed}`;
	return `${label}:\n${trimmed}`;
}

function truncateForLLM(text: string): string {
	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;
	return (
		`[output truncated: kept last ${truncation.outputLines}/${truncation.totalLines} lines, ` +
		`${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}]\n` +
		truncation.content
	);
}
