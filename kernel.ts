/**
 * PythonKernel — long-lived python3 subprocess speaking the runner.py
 * NDJSON wire protocol. One kernel per pi session.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "runner.py");

/** Provider/secret env vars stripped before launching python. */
const ENV_DENYLIST_PREFIXES = [
	"OPENAI_",
	"ANTHROPIC_",
	"GEMINI_",
	"GOOGLE_API",
	"GOOGLE_GENERATIVE",
	"GROQ_",
	"MISTRAL_",
	"XAI_",
	"DEEPSEEK_",
	"COHERE_",
	"PERPLEXITY_",
	"TOGETHER_",
	"FIREWORKS_",
	"OPENROUTER_",
	"AZURE_OPENAI",
	"HUGGINGFACE_",
	"HF_TOKEN",
	"REPLICATE_",
	"AWS_SECRET",
	"AWS_SESSION",
];

const ENV_DENYLIST_EXACT = new Set([
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"NPM_TOKEN",
	"NPM_PASSWORD",
	"PI_API_KEY",
]);

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
	timer?: NodeJS.Timeout;
	cellsRun: number;
	reset: boolean;
	onUpdate?: (snapshot: ExecuteResult) => void;
}

export type CompileStatus = "complete" | "incomplete" | "error";

export interface CompileCheckResult {
	status: CompileStatus;
	error: string;
}

export interface CheckpointResult {
	ok: boolean;
	skipped: boolean;
	reason: string;
	bytes: number;
	durationMs: number;
	keysPicked: number;
	keysSkipped: number;
	skippedNames: string[];
}

export interface RestoreResult {
	ok: boolean;
	error: string;
	keysRestored: number;
	keysFailed: number;
	failedNames: string[];
	durationMs: number;
}

/** Generic single-shot RPC awaiter, used for compile_check / checkpoint / restore. */
interface PendingRpc {
	resolve: (msg: Record<string, unknown>) => void;
	reject: (err: Error) => void;
	expectedType: string;
}

export class PythonKernel {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private pending: PendingRequest | null = null;
	private pendingRpc = new Map<string, PendingRpc>();
	private readyInfo: KernelInfo | null = null;
	private pickler: "dill" | "pickle" | null = null;
	private readyPromise: Promise<KernelInfo> | null = null;
	private readyResolve: ((info: KernelInfo) => void) | null = null;
	private readyReject: ((err: Error) => void) | null = null;
	private exitReason: string | null = null;
	private nextRequestId = 1;

	constructor(private readonly options: KernelOptions) {}

	getInfo(): KernelInfo | null {
		return this.readyInfo;
	}

	/** Which serializer the runner is using for checkpoints, if known. */
	getPickler(): "dill" | "pickle" | null {
		return this.pickler;
	}

	isAlive(): boolean {
		return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
	}

	/** Lazily spawn and wait for the runner's `ready` event. */
	async start(): Promise<KernelInfo> {
		if (this.readyInfo) return this.readyInfo;
		if (this.readyPromise) return this.readyPromise;

		const env = filterEnv(this.options.env ?? process.env);
		// Make sure cwd ends up in sys.path (runner does this too, belt + braces).
		env.PYTHONUNBUFFERED = "1";

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
		proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		proc.stderr.on("data", (chunk: string) => this.onStderrOutOfBand(chunk));

		proc.on("error", (err) => {
			this.fail(err);
		});
		proc.on("exit", (code, signal) => {
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
		for (const rpc of this.pendingRpc.values()) rpc.reject(err);
		this.pendingRpc.clear();
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
			const pickler = msg.pickler;
			if (pickler === "dill" || pickler === "pickle") this.pickler = pickler;
			this.readyResolve?.(this.readyInfo);
			this.readyResolve = null;
			this.readyReject = null;
			return;
		}

		if (
			type === "compile_check_result" ||
			type === "checkpoint_result" ||
			type === "restore_result"
		) {
			const id = String(msg.id ?? "");
			const rpc = this.pendingRpc.get(id);
			if (!rpc) return;
			this.pendingRpc.delete(id);
			rpc.resolve(msg);
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
		};
	}

	private finalize(pending: PendingRequest): void {
		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
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
			pending.timer = setTimeout(() => {
				pending.timedOut = true;
				pending.cancelled = true;
				this.interrupt();
				// Hard-kill if it doesn't comply within a grace period so the
				// user isn't stuck waiting on a runaway loop.
				setTimeout(() => {
					if (this.pending === pending) this.kill();
				}, 1500);
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
			if (pending.timer) clearTimeout(pending.timer);
		}
	}

	/** Send a single-shot RPC and await the matching `<type>_result` response. */
	private async sendRpc(
		prefix: string,
		expectedType: string,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!this.isAlive()) await this.start();
		const proc = this.proc;
		if (!proc) throw new Error("python kernel not running");

		const id = `${prefix}-${this.nextRequestId++}`;
		const promise = new Promise<Record<string, unknown>>((resolveRpc, rejectRpc) => {
			this.pendingRpc.set(id, { resolve: resolveRpc, reject: rejectRpc, expectedType });
		});

		try {
			proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
		} catch (err) {
			this.pendingRpc.delete(id);
			throw err instanceof Error ? err : new Error(String(err));
		}
		return promise;
	}

	/**
	 * Ask the runner whether `code` is a complete Python statement.
	 * Used by the REPL component to know when to switch the prompt to `... `.
	 */
	async checkSyntax(code: string): Promise<CompileCheckResult> {
		const msg = await this.sendRpc("chk", "compile_check_result", {
			type: "compile_check",
			code,
		});
		return {
			status: (msg.status as CompileStatus) ?? "error",
			error: String(msg.error ?? ""),
		};
	}

	/** Ask the runner to pickle the current namespace to `path`. */
	async checkpoint(path: string, maxBytes?: number): Promise<CheckpointResult> {
		const msg = await this.sendRpc("ckpt", "checkpoint_result", {
			type: "checkpoint",
			path,
			...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}),
		});
		return {
			ok: Boolean(msg.ok),
			skipped: Boolean(msg.skipped),
			reason: String(msg.reason ?? ""),
			bytes: Number(msg.bytes ?? 0),
			durationMs: Number(msg.duration_ms ?? 0),
			keysPicked: Number(msg.keys_picked ?? 0),
			keysSkipped: Number(msg.keys_skipped ?? 0),
			skippedNames: Array.isArray(msg.skipped_names)
				? (msg.skipped_names as unknown[]).map(String)
				: [],
		};
	}

	/** Restore a previously-written checkpoint into the current namespace. */
	async restore(path: string): Promise<RestoreResult> {
		const msg = await this.sendRpc("rst", "restore_result", {
			type: "restore",
			path,
		});
		return {
			ok: Boolean(msg.ok),
			error: String(msg.error ?? ""),
			keysRestored: Number(msg.keys_restored ?? 0),
			keysFailed: Number(msg.keys_failed ?? 0),
			failedNames: Array.isArray(msg.failed_names)
				? (msg.failed_names as unknown[]).map(String)
				: [],
			durationMs: Number(msg.duration_ms ?? 0),
		};
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

	/** Hard-kill the kernel. The next execute() will respawn it. */
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
		this.pickler = null;
		if (this.pending) {
			this.pending.reject(new Error("python kernel killed"));
			this.pending = null;
		}
		for (const rpc of this.pendingRpc.values()) {
			rpc.reject(new Error("python kernel killed"));
		}
		this.pendingRpc.clear();
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

/** Build the env handed to the python subprocess, stripping likely secrets. */
export function filterEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (ENV_DENYLIST_EXACT.has(key)) continue;
		if (ENV_DENYLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		if (/_API_KEY$/i.test(key)) continue;
		if (/_SECRET$/i.test(key)) continue;
		if (/_TOKEN$/i.test(key)) continue;
		out[key] = value;
	}
	return out;
}

/** Resolve which python interpreter to use. */
export function resolvePythonPath(opts: {
	override?: string | null;
	cwd: string;
	env?: NodeJS.ProcessEnv;
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
	for (const dir of [".venv", "venv"]) {
		candidates.push(resolve(opts.cwd, dir, "bin", "python"));
		candidates.push(resolve(opts.cwd, dir, "Scripts", "python.exe"));
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
