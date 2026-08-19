/**
 * pi-python — exposes a persistent Python execution environment to the agent.
 *
 * Tools registered:
 *   - python                : execute one or more Python cells in a long-lived kernel
 *   - python_set_interpreter : switch the kernel to a different python binary
 *
 * Slash commands:
 *   - /python-status  : kernel + interpreter + settings info
 *   - /python-restart : kill and respawn the kernel. The namespace is lost;
 *                       use when a cell hangs or the kernel is wedged.
 *
 * CLI flags:
 *   --python <path>   : override the interpreter used for new kernels
 *
 * Lifetime:
 *   The namespace lives in the kernel process and nowhere else. It survives
 *   for as long as that process does — across tool calls, across cells,
 *   across timeouts (SIGINT leaves the process alive). It does NOT survive
 *   /python-restart, python_set_interpreter, a hard kill after an ignored
 *   SIGINT, or a pi restart.
 *
 *   This used to be backed by a per-tool-call pickle of the whole namespace
 *   under ~/.pi/pi-python/<sessionId>/<leafId>.pkl, restored on the next
 *   kernel spawn. It was removed: restores were rarely useful in practice
 *   (neither across /fork nor when navigating back through history), while
 *   the snapshots cost a full namespace serialization on every single call
 *   and grew without bound on disk — 80 GB across 421 sessions before the
 *   feature was pulled. Re-running the cells is cheaper and more
 *   predictable than resurrecting a stale namespace.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	highlightCode,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { existsSync, statSync } from "node:fs";
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
import { loadSettings } from "./settings.ts";

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 1;
// Upper bound the agent can request via the `timeout` param. The setting
// `maxTimeoutSeconds` overrides this at clamp time, so users with very
// long-running cells (data pulls, training) can raise the ceiling without
// touching the extension. Default 1h.
const DEFAULT_MAX_TIMEOUT_S = 3600;

export default function pythonExtension(pi: ExtensionAPI) {
	let kernel: PythonKernel | null = null;
	// Active explicit interpreter override. Sourced from --python at startup
	// and updatable at runtime via the python_set_interpreter tool.
	let pythonOverride: string | null = null;

	pi.registerFlag("python", {
		description: "Path to the Python interpreter pi-python should use",
		type: "string",
	});

	const ensureKernel = async (cwd: string): Promise<PythonKernel> => {
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
			"The namespace lives in the kernel process: it survives across tool calls and " +
			"across cell timeouts, but not across /python-restart or a pi restart. " +
			"Cells run sequentially; if a cell raises, later cells are skipped. " +
			`Default timeout is ${DEFAULT_TIMEOUT_S}s (cap ${DEFAULT_MAX_TIMEOUT_S}s by default, ` +
			"raise via project settings.json `maxTimeoutSeconds`); pass a higher `timeout` for " +
			"long-running work. On timeout the cell is SIGINT'd \u2014 the runner catches " +
			"KeyboardInterrupt cleanly and the namespace from cells that completed first " +
			"survives for the next call. Use cells: [{code: '...'}].",
		promptSnippet:
			"Run Python code in a persistent kernel for data wrangling, math, and parsing",
		promptGuidelines: [
			"Use python for non-trivial data transforms, JSON/CSV parsing, math, and stateful scratch work.",
			"Use python with multiple cells when you want to inspect intermediate results without rerunning earlier setup.",
			`Pass python's \`timeout\` parameter (in seconds, up to ${DEFAULT_MAX_TIMEOUT_S}) for long-running work like training, large IO, or expensive aggregations \u2014 the default of ${DEFAULT_TIMEOUT_S}s is tuned for interactive scratch work.`,
			"Long cells that hit a timeout still preserve namespace state from any cells that completed first \u2014 you can resume work in a follow-up `python` call without restarting from scratch.",
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
					description:
						`Wall-clock timeout in seconds for the whole call. Defaults to ${DEFAULT_TIMEOUT_S}s. ` +
						`Maximum is ${DEFAULT_MAX_TIMEOUT_S}s out of the box (1h), configurable per project via ` +
						"settings.json `maxTimeoutSeconds`. On timeout the runner is SIGINT'd; the kernel " +
						"catches KeyboardInterrupt and keeps the namespace, so any state populated by cells " +
						"that completed before the interrupt survives.",
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
		renderCall(args, theme, context) {
			const state = context.state as PythonRenderState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

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
		renderResult(result, options, _theme, context) {
			const state = context.state as PythonRenderState;

			// Start a 1s redraw tick while partial so the elapsed counter
			// updates live — same pattern as the built-in Bash tool.
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}

			// Build a fresh container each render. The body text is already
			// fully formatted by formatExecuteResult; we just append a
			// timing footer.
			const container = new Container();

			// Main result text.
			const firstContent = result.content?.[0];
			const body = (firstContent && "text" in firstContent) ? firstContent.text : "";
			if (body) {
				container.addChild(new Text(body, 0, 0));
			}

			// Footer: elapsed/took time (+ timeout if set).
			if (state.startedAt !== undefined) {
				const label = options.isPartial ? "Elapsed" : "Took";
				const endTime = state.endedAt ?? Date.now();
				const elapsed = formatDurationMs(endTime - state.startedAt);

				const args = context.args;
				const timeout = args?.timeout;
				const timeoutSuffix = timeout ? ` / timeout ${timeout}s` : "";

				container.addChild(
					new Text(`\n${label} ${elapsed}${timeoutSuffix}`, 0, 0),
				);
			}

			return container;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = resolveCwd(params.cwd, ctx.cwd);
			const cells: CellRequest[] = params.cells.map(
				(c: { code: string; title?: string }) => ({
					code: c.code,
					title: c.title,
				}),
			);
			const { values: callSettings } = loadSettings({ cwd });
			const timeoutS = clampTimeout(params.timeout, callSettings.maxTimeoutSeconds);

			const k = await ensureKernel(cwd);

			const result = await k.execute(cells, {
				timeoutMs: timeoutS * 1000,
				reset: params.reset,
				cwd,
				signal,
				interruptGraceMs: callSettings.interruptGraceMs,
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
					killed: result.killed ?? false,
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
			"so all in-memory variables, imports, and definitions are discarded. " +
			"Use this to access libraries installed in a specific venv.",
		promptSnippet:
			"Switch the persistent Python kernel to a specific interpreter binary (e.g. a venv's python) to access different installed libraries",
		promptGuidelines: [
			"Use python_set_interpreter when the user asks for a specific Python version or wants libraries from a particular venv. The path must point at the python binary itself (e.g. <venv>/bin/python), not the venv directory.",
			"After python_set_interpreter, the kernel namespace is empty — re-import anything you need before continuing.",
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

			try {
				const k = await ensureKernel(ctx.cwd);
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
							`namespace is fresh.`,
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
		description: "Show pi-python kernel, interpreter, and settings status",
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
				`  maxTimeoutSeconds: ${settings.maxTimeoutSeconds}s ` +
					`(source: ${sources.maxTimeoutSeconds})`,
			);
			lines.push(
				`  interruptGraceMs:  ${settings.interruptGraceMs}ms ` +
					`(source: ${sources.interruptGraceMs})`,
			);
			for (const w of warnings) lines.push(`  warning: ${w}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("python-restart", {
		description: "Restart the pi-python kernel (discards the namespace)",
		handler: async (_args, ctx) => {
			if (kernel) {
				const info = kernel.getInfo();
				const ok = await ctx.ui.confirm(
					"Restart Python kernel?",
					`This kills ${info ? `pid ${info.pid}` : "the current kernel"} ` +
						`(interrupting any hung cell) and respawns it with an empty ` +
						`namespace. Every variable, import, and definition is lost — ` +
						`re-run the cells you still need.`,
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

			try {
				const k = await ensureKernel(ctx.cwd);
				const info = k.getInfo();
				ctx.ui.notify(
					`pi-python: kernel restarted (pid ${info?.pid ?? "?"}), namespace is empty`,
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

	// Note: `session_tree` is deliberately NOT hooked. Time travel rewinds
	// the conversation, not the interpreter — the kernel keeps whatever the
	// cells actually put in it. Killing it on navigation was the old
	// behaviour, which paired with checkpoint-restore; without restore that
	// would just silently destroy a namespace every time you moved around
	// the tree. If the namespace and the visible history disagree after a
	// rewind, use /python-restart to get a clean one.

	pi.on("session_shutdown", async () => {
		await killKernel();
	});
}

// ─── types (module scope) ───────────────────────────────────────────────────

/** Renderer state carried across renderCall / renderResult for a single tool invocation. */
interface PythonRenderState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

// ─── helpers (module scope) ─────────────────────────────────────────────────

function formatDurationMs(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = s - m * 60;
	return `${m}m${rem.toFixed(0)}s`;
}

function clampTimeout(value: number | undefined, maxSeconds: number): number {
	const cap = Math.max(MIN_TIMEOUT_S, Math.floor(maxSeconds));
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return Math.min(DEFAULT_TIMEOUT_S, cap);
	}
	return Math.min(Math.max(value, MIN_TIMEOUT_S), cap);
}

function resolveCwd(requested: string | undefined, fallback: string): string {
	if (!requested) return fallback;
	const abs = resolve(fallback, requested);
	if (!existsSync(abs) || !statSync(abs).isDirectory()) {
		return abs;
	}
	return abs;
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
	if (result.killed) {
		// Be explicit about both halves: the output below is real and
		// complete up to the hang, and the namespace behind it is gone. A
		// bare "kernel died" leaves the caller unsure whether to trust
		// either.
		lines.push(
			"[timed out, then hard-killed — the cell ignored SIGINT (typically a C " +
				"extension or blocking socket). Output above this point is complete; the " +
				"kernel namespace is GONE and the next call starts empty, so re-run any " +
				"setup you still need. Raise `timeout` or `interruptGraceMs` if the work " +
				"was simply slow.]",
		);
	} else if (result.timedOut) lines.push(`[timed out]`);
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
