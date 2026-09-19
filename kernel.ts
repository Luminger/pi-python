/**
 * PythonKernel — long-lived python3 subprocess speaking the runner.py
 * NDJSON wire protocol. One kernel per pi session.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "runner.py");

export interface CellRequest {
	code: string;
	title?: string;
}

export interface CellResult {
	index: number;
	title?: string;
	stdout: string;
	stderr: string;
	value: string; // repr of the last expression, or "" for statements
	ok: boolean;
	exception: string; // formatted traceback when !ok
}

export interface ExecuteResult {
	cells: CellResult[];
	cancelled: boolean;
	timedOut: boolean;
	cellsRun: number;
	reset: boolean;
	/**
	 * The kernel process was hard-killed while this request was in flight,
	 * so the namespace is gone. Output captured before the kill is still
	 * present in `cells` — the whole point of surfacing this as a result
	 * rather than an exception.
	 */
	killed?: boolean;
}

export interface KernelInfo {
	python: string;
	executable: string;
	pid: number;
	cwd: string;
}

export interface KernelOptions {
	pythonPath: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
	id: string;
	resolve: (result: ExecuteResult) => void;
	reject: (err: Error) => void;
	cells: Map<number, CellResult>;
	requestedCells: CellRequest[];
	cancelled: boolean;
	timedOut: boolean;
	killed?: boolean;
	/** Fires at `timeoutMs`: marks the timeout and sends the first SIGINT. */
	timer?: NodeJS.Timeout;
	/** Fires at graceMs/2 after the timeout: second SIGINT. */
	retryTimer?: NodeJS.Timeout;
	/** Fires at graceMs after the timeout: SIGKILL. */
	graceTimer?: NodeJS.Timeout;
	cellsRun: number;
	reset: boolean;
	onUpdate?: (snapshot: ExecuteResult) => void;
}

export class PythonKernel {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private pending: PendingRequest | null = null;
	private readyInfo: KernelInfo | null = null;
	private readyPromise: Promise<KernelInfo> | null = null;
	private readyResolve: ((info: KernelInfo) => void) | null = null;
	private readyReject: ((err: Error) => void) | null = null;
	private exitReason: string | null = null;
	private nextRequestId = 1;

	constructor(private readonly options: KernelOptions) {}

	getInfo(): KernelInfo | null {
		return this.readyInfo;
	}

	isAlive(): boolean {
		// `proc.killed` is set to true by Node *whenever* we call proc.kill(),
		// even with a non-fatal signal (SIGINT just interrupts). The only
		// reliable "the process is still running" check is whether it has
		// reported an exit yet — exitCode and signalCode are both null until
		// then.
		if (this.proc === null) return false;
		return this.proc.exitCode === null && this.proc.signalCode === null;
	}

	/** Lazily spawn and wait for the runner's `ready` event. */
	async start(): Promise<KernelInfo> {
		if (this.readyInfo) return this.readyInfo;
		if (this.readyPromise) return this.readyPromise;

		// Python is a first-class execution environment, not a sandbox. Inherit
		// the host environment unchanged so project tooling and credentials work
		// exactly as they do from the user's shell.
		const env = { ...(this.options.env ?? process.env), PYTHONUNBUFFERED: "1" };

		const proc = spawn(this.options.pythonPath, ["-u", RUNNER_PATH], {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc = proc;
		this.readyPromise = new Promise<KernelInfo>((resolveReady, rejectReady) => {
			this.readyResolve = resolveReady;
			this.readyReject = rejectReady;
		});

		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");

		// Every handler below is bound to THIS process object and must ignore
		// events once it is no longer the live kernel.
		//
		// Node delivers a killed child's `exit` asynchronously, well after
		// kill() returns. Without this guard the corpse's exit event lands on
		// whatever is current by then — rejecting the *replacement* kernel's
		// startup with "Python kernel exited (signal SIGKILL)", or failing a
		// perfectly healthy in-flight request on the new process. That reads
		// exactly like a kernel dying at random for no reason.
		const isCurrent = () => this.proc === proc;

		proc.stdout.on("data", (chunk: string) => {
			if (isCurrent()) this.onStdout(chunk);
		});
		proc.stderr.on("data", (chunk: string) => {
			if (isCurrent()) this.onStderrOutOfBand(chunk);
		});

		proc.on("error", (err) => {
			if (!isCurrent()) return;
			this.fail(err);
		});
		proc.on("exit", (code, signal) => {
			if (!isCurrent()) return;
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			this.exitReason = reason;
			this.fail(new Error(`Python kernel exited (${reason})`));
		});

		try {
			return await this.readyPromise;
		} catch (err) {
			this.proc = null;
			throw err;
		}
	}

	private fail(err: Error): void {
		if (this.readyReject) {
			this.readyReject(err);
			this.readyResolve = null;
			this.readyReject = null;
		}
		if (this.pending) {
			this.pending.reject(err);
			this.pending = null;
		}
	}

	private onStderrOutOfBand(data: string): void {
		// The runner sends framed events on stdout. Anything on stderr is
		// usually an interpreter-level diagnostic (import errors, etc.).
		// Surface it as part of the current request if there is one, or
		// stash it on the ready failure.
		if (this.pending) {
			this.pending.cells.set(-1, {
				index: -1,
				stdout: "",
				stderr:
					(this.pending.cells.get(-1)?.stderr ?? "") + data,
				value: "",
				ok: false,
				exception: "",
			});
			this.pending.onUpdate?.(this.snapshot(this.pending));
		}
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf("\n");
		while (nl >= 0) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.length > 0) this.handleLine(line);
			nl = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line);
		} catch {
			// Non-JSON output from the runner shouldn't happen, but if it does,
			// dump it into the current request's stderr stream.
			if (this.pending) {
				this.appendStream(this.pending, -1, "stderr", `${line}\n`);
			}
			return;
		}

		const type = msg.type as string | undefined;
		if (type === "ready") {
			this.readyInfo = {
				python: String(msg.python ?? ""),
				executable: String(msg.executable ?? this.options.pythonPath),
				pid: Number(msg.pid ?? this.proc?.pid ?? 0),
				cwd: String(msg.cwd ?? this.options.cwd),
			};
			this.readyResolve?.(this.readyInfo);
			this.readyResolve = null;
			this.readyReject = null;
			return;
		}

		if (!this.pending || msg.id !== this.pending.id) {
			// Stale or unsolicited message — ignore.
			return;
		}

		const pending = this.pending;
		const cellIndex = typeof msg.cell === "number" ? msg.cell : -1;

		switch (type) {
			case "stdout":
			case "stderr":
				this.appendStream(pending, cellIndex, type, String(msg.data ?? ""));
				break;
			case "cell_end": {
				const cell = this.ensureCell(pending, cellIndex);
				cell.ok = Boolean(msg.ok);
				cell.value = String(msg.value ?? "");
				cell.exception = String(msg.exception ?? "");
				pending.cellsRun = Math.max(pending.cellsRun, cellIndex + 1);
				pending.onUpdate?.(this.snapshot(pending));
				break;
			}
			case "done": {
				pending.cellsRun = Number(msg.cells_run ?? pending.cellsRun);
				pending.reset = Boolean(msg.reset ?? pending.reset);
				this.finalize(pending);
				break;
			}
			case "fatal": {
				pending.cancelled = true;
				const err = new Error(`python kernel fatal: ${msg.error ?? "unknown"}`);
				pending.reject(err);
				this.pending = null;
				break;
			}
			default:
				// Unknown type — ignore so we stay forward-compatible.
				break;
		}
	}

	private ensureCell(pending: PendingRequest, index: number): CellResult {
		let cell = pending.cells.get(index);
		if (!cell) {
			const requested = index >= 0 ? pending.requestedCells[index] : undefined;
			cell = {
				index,
				title: requested?.title,
				stdout: "",
				stderr: "",
				value: "",
				ok: false,
				exception: "",
			};
			pending.cells.set(index, cell);
		}
		return cell;
	}

	private appendStream(
		pending: PendingRequest,
		index: number,
		stream: "stdout" | "stderr",
		data: string,
	): void {
		const cell = this.ensureCell(pending, index);
		if (stream === "stdout") cell.stdout += data;
		else cell.stderr += data;
		pending.onUpdate?.(this.snapshot(pending));
	}

	private snapshot(pending: PendingRequest): ExecuteResult {
		const cells = [...pending.cells.values()]
			.filter((cell) => cell.index >= 0)
			.sort((a, b) => a.index - b.index);
		return {
			cells,
			cancelled: pending.cancelled,
			timedOut: pending.timedOut,
			cellsRun: pending.cellsRun,
			reset: pending.reset,
			...(pending.killed ? { killed: true } : {}),
		};
	}

	private finalize(pending: PendingRequest): void {
		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
		}
		// The cell answered the SIGINT after all — disarm the escalation so
		// we don't SIGKILL a kernel that just recovered.
		if (pending.retryTimer) {
			clearTimeout(pending.retryTimer);
			pending.retryTimer = undefined;
		}
		if (pending.graceTimer) {
			clearTimeout(pending.graceTimer);
			pending.graceTimer = undefined;
		}
		const result = this.snapshot(pending);
		this.pending = null;
		pending.resolve(result);
	}

	/**
	 * Execute one or more cells. Throws if a previous request is still in flight.
	 */
	async execute(
		cells: CellRequest[],
		opts: {
			timeoutMs?: number;
			reset?: boolean;
			signal?: AbortSignal;
			cwd?: string;
			onUpdate?: (snapshot: ExecuteResult) => void;
			/**
			 * How long to wait after the timeout SIGINT before hard-killing
			 * the kernel. Default 30s. Set to 0 to never auto-kill (rely on
			 * the user's /python-restart for truly wedged kernels).
			 */
			interruptGraceMs?: number;
		} = {},
	): Promise<ExecuteResult> {
		if (!this.isAlive()) {
			await this.start();
		}
		if (this.pending) {
			throw new Error("python kernel is busy");
		}
		const proc = this.proc;
		if (!proc) throw new Error("python kernel not running");

		const id = `req-${this.nextRequestId++}`;
		const pending: PendingRequest = {
			id,
			resolve: () => {},
			reject: () => {},
			cells: new Map(),
			requestedCells: cells,
			cancelled: false,
			timedOut: false,
			cellsRun: 0,
			reset: Boolean(opts.reset),
			onUpdate: opts.onUpdate,
		};

		const promise = new Promise<ExecuteResult>((resolveExec, rejectExec) => {
			pending.resolve = resolveExec;
			pending.reject = rejectExec;
		});
		this.pending = pending;

		// Pre-seed cells so partial snapshots reflect requested order.
		cells.forEach((cell, i) => {
			pending.cells.set(i, {
				index: i,
				title: cell.title,
				stdout: "",
				stderr: "",
				value: "",
				ok: false,
				exception: "",
			});
		});

		const onAbort = () => {
			pending.cancelled = true;
			this.interrupt();
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			const graceMs = opts.interruptGraceMs ?? 30_000;
			pending.timer = setTimeout(() => {
				pending.timedOut = true;
				pending.cancelled = true;
				this.interrupt();
				// Send SIGINT first; the runner re-enables Python's default
				// interrupt handler around each cell so the SIGINT becomes a
				// KeyboardInterrupt the cell catches, returning cleanly with
				// the namespace intact.
				//
				// A cell sitting inside a C extension (capstone, pysap,
				// playwright, a blocking socket read) never reaches an
				// interpreter check, so the first SIGINT does nothing. Send a
				// second one midway through the grace period: Python-level
				// loops that swallowed the first, and libraries that install
				// their own handler, often act on the repeat.
				if (graceMs > 0) {
					pending.retryTimer = setTimeout(
						() => {
							if (this.pending === pending) this.interrupt();
						},
						Math.floor(graceMs / 2),
					);
					// Last resort. Costs the namespace, so the result carries
					// `killed` and every byte captured so far.
					pending.graceTimer = setTimeout(() => {
						if (this.pending === pending) this.kill();
					}, graceMs);
				}
			}, opts.timeoutMs);
		}

		const payload = JSON.stringify({
			id,
			cells: cells.map((c) => ({ code: c.code, title: c.title })),
			reset: Boolean(opts.reset),
			cwd: opts.cwd,
		});

		try {
			proc.stdin.write(`${payload}\n`);
		} catch (err) {
			this.pending = null;
			throw err instanceof Error ? err : new Error(String(err));
		}

		try {
			return await promise;
		} finally {
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			// All three must be cleared: the grace/retry timers outlive the
			// timeout timer by design, and a stray one left armed keeps the
			// event loop alive for up to graceMs after the call returned.
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.retryTimer) clearTimeout(pending.retryTimer);
			if (pending.graceTimer) clearTimeout(pending.graceTimer);
		}
	}

	/** Send SIGINT to interrupt the currently running cell. */
	interrupt(): void {
		if (this.proc && this.proc.exitCode === null) {
			try {
				this.proc.kill("SIGINT");
			} catch {
				// best-effort
			}
		}
	}

	/**
	 * Hard-kill the kernel. The next execute() will respawn it.
	 *
	 * If a request is in flight it is *resolved* with whatever output the
	 * cells produced before the kill, flagged `killed`, rather than
	 * rejected. Rejecting used to throw away every byte the cell had
	 * printed — a 10-minute sweep that hung on its last HTTP call came back
	 * as the bare string "python kernel killed" with all its findings
	 * discarded. Partial output is usually the most valuable thing we have
	 * at that point, so it must survive.
	 */
	kill(): void {
		if (!this.proc) return;
		try {
			this.proc.kill("SIGKILL");
		} catch {
			// best-effort
		}
		this.proc = null;
		this.readyInfo = null;
		this.readyPromise = null;
		if (this.pending) {
			const pending = this.pending;
			this.pending = null;
			pending.killed = true;
			pending.cancelled = true;
			pending.resolve(this.snapshot(pending));
		}
	}

	/** Polite shutdown — close stdin so the runner exits, then reap. */
	async shutdown(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		try {
			proc.stdin.end();
		} catch {
			// ignore
		}
		const exited = await new Promise<boolean>((resolveExit) => {
			const timer = setTimeout(() => resolveExit(false), 500);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolveExit(true);
			});
		});
		if (!exited) this.kill();
		this.proc = null;
		this.readyInfo = null;
		this.readyPromise = null;
	}
}

/**
 * Resolve which python interpreter to use.
 *
 * Order of precedence:
 *   1. Explicit `override` (the `--python` flag or `python_set_interpreter`).
 *   2. `$PI_PYTHON` env var.
 *   3. `$VIRTUAL_ENV` env var (canonical for direnv / `source .venv/bin/activate`).
 *   4. A venv directory — named by `venvDirNames`, default `.venv` and
 *      `venv` — found in `cwd`. When `walkParents` is true (the default),
 *      the search ascends from `cwd` until either a venv is found or a
 *      repo root (dir with `.git`) is encountered — we never cross a repo
 *      boundary, so a pi session started in some unrelated subdir won't
 *      latch onto a far-away venv.
 *   5. Bare `python3` / `python.exe` on PATH; spawn() resolves it.
 */
export function resolvePythonPath(opts: {
	override?: string | null;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	walkParents?: boolean;
	venvDirNames?: string[];
}): string {
	const env = opts.env ?? process.env;

	// Explicit override wins. Validate it points at an actual binary so a
	// stale override doesn't silently fall back and leave the user wondering
	// why the wrong python is in use.
	if (opts.override) {
		return validateInterpreterPath(opts.override);
	}

	const candidates: string[] = [];
	if (env.PI_PYTHON) candidates.push(env.PI_PYTHON);
	if (env.VIRTUAL_ENV) {
		candidates.push(join(env.VIRTUAL_ENV, "bin", "python"));
		candidates.push(join(env.VIRTUAL_ENV, "Scripts", "python.exe"));
	}

	const venvDirs = opts.venvDirNames ?? [".venv", "venv"];
	const walk = opts.walkParents !== false;
	let dir = opts.cwd;
	while (true) {
		for (const sub of venvDirs) {
			candidates.push(resolve(dir, sub, "bin", "python"));
			candidates.push(resolve(dir, sub, "Scripts", "python.exe"));
		}
		if (!walk) break;
		// This level is a repo root — search it (already pushed above) then stop.
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break; // filesystem root
		dir = parent;
	}

	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	// Fall through to a name on PATH; spawn() will resolve it.
	return process.platform === "win32" ? "python.exe" : "python3";
}

/**
 * Validate that `input` points at a python interpreter binary.
 *
 * Accepts:
 *   - an absolute or relative path to an existing file
 *   - a bare command name (e.g. "python3.12") to be resolved on PATH by spawn()
 *
 * Rejects directories — if a venv happens to live behind the binary, that's
 * incidental; callers must pass the binary path itself, not the venv root.
 */
export function validateInterpreterPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("interpreter path is empty");

	// Bare command names (no path separator) are deferred to PATH lookup at
	// spawn time. We don't try to resolve them eagerly because PATH may
	// differ between the host process and the eventual subprocess env.
	const looksLikePath = isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\");
	if (!looksLikePath) return trimmed;

	const path = resolve(trimmed);
	if (!existsSync(path)) {
		throw new Error(`Python interpreter not found: ${path}`);
	}
	if (statSync(path).isDirectory()) {
		throw new Error(
			`Expected a python interpreter binary, got a directory: ${path}. ` +
				`Pass the path to the interpreter itself (e.g. ${join(path, "bin", "python")}).`,
		);
	}
	return path;
}

export interface InterpreterCheck {
	ok: boolean;
	/** First line of stdout when ok (e.g. "Python 3.12.3"), or empty. */
	version: string;
	/** Error message when !ok. */
	error: string;
}

/**
 * Cheap smoke-test: spawn `<interpreter> --version` synchronously and
 * inspect the result. Catches typos in --python flags / settings before the
 * agent makes its first call. Pure validation — no kernel started.
 */
export function verifyInterpreterRuns(
	interpreter: string,
	timeoutMs = 3000,
): InterpreterCheck {
	try {
		const result = spawnSync(interpreter, ["--version"], {
			encoding: "utf-8",
			timeout: timeoutMs,
			shell: false,
		});
		if (result.error) {
			return { ok: false, version: "", error: result.error.message };
		}
		if (result.signal) {
			return { ok: false, version: "", error: `killed by signal ${result.signal}` };
		}
		if (result.status !== 0) {
			const stderr = (result.stderr ?? "").trim();
			return {
				ok: false,
				version: "",
				error: `exit ${result.status}${stderr ? `: ${stderr}` : ""}`,
			};
		}
		// `python --version` writes to stdout on 3.4+, stderr on older builds.
		const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		const firstLine = combined.split("\n")[0]?.trim() ?? "";
		return { ok: true, version: firstLine, error: "" };
	} catch (err) {
		return {
			ok: false,
			version: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
