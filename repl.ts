/**
 * PythonReplComponent — an in-pi interactive Python shell.
 *
 * Renders a scrollback buffer plus a single-line `Input` for the prompt.
 * Talks to the same persistent PythonKernel the LLM uses, so variables,
 * imports, and definitions are shared between the REPL and the agent.
 *
 * Behavior:
 *   - Enter:      submit the current line. If the accumulated buffer doesn't
 *                 yet form a complete statement (per codeop.compile_command),
 *                 the prompt switches to `... ` and waits for more lines.
 *   - Ctrl+C:     while idle, clear the current input line.
 *                 while busy, send SIGINT to the kernel.
 *   - Ctrl+D:     exit (or, with text in the buffer, clear it first).
 *   - Esc:        exit.
 *   - Up / Down:  recall previous / next submitted code (per-session history).
 *   - :q          typing `:q` (alone) on a fresh prompt also exits.
 *
 * Output is streamed live: stdout/stderr chunks from the kernel are appended
 * to scrollback as they arrive.
 */

import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { ExecuteResult, PythonKernel } from "./kernel.ts";

type EntryKind =
	| "in" // user input echo (>>> code)
	| "cont" // user input echo for continuation lines (... code)
	| "out" // stdout chunk
	| "err" // stderr chunk
	| "val" // last-expression repr
	| "exc" // exception traceback
	| "info" // header / system messages
	| "warn"; // local warnings (e.g. interrupt notice)

interface Entry {
	kind: EntryKind;
	text: string;
	/** False while the entry may still receive more chunks (no trailing \n yet). */
	closed: boolean;
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface TuiLike {
	requestRender: () => void;
}

export interface PythonReplOptions {
	kernel: PythonKernel;
	tui: TuiLike;
	theme: ThemeLike;
	cwd: string;
	onDone: () => void;
}

export class PythonReplComponent implements Component, Focusable {
	private readonly kernel: PythonKernel;
	private readonly tui: TuiLike;
	private readonly theme: ThemeLike;
	private readonly cwd: string;
	private readonly onDone: () => void;

	private readonly input: Input;
	private readonly history: Entry[] = [];
	/** Accumulated lines for a multi-line statement (excluding the line being typed). */
	private contBuf: string[] = [];
	/** Submitted commands, for up/down recall. */
	private cmdHistory: string[] = [];
	private cmdHistoryIdx = -1;
	/** Saved input value when navigating history, restored on cmdHistoryIdx === -1. */
	private cmdHistoryDraft = "";

	private busy = false;
	private closed = false;
	private _focused = false;

	constructor(opts: PythonReplOptions) {
		this.kernel = opts.kernel;
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.cwd = opts.cwd;
		this.onDone = opts.onDone;

		this.input = new Input();
		this.input.onSubmit = (value) => {
			void this.submitLine(value);
		};
		this.input.onEscape = () => this.exit();

		const info = this.kernel.getInfo();
		this.pushClosed("info", info ? `Python ${info.python.split("\n")[0]}` : "Python REPL");
		this.pushClosed(
			"info",
			info ? `pi-python kernel · pid ${info.pid} · ${info.executable}` : "pi-python kernel",
		);
		this.pushClosed("info", "Esc / Ctrl+D / :q to exit · ↑↓ history · Ctrl+C interrupt");
		this.pushClosed("info", "");
	}

	// ── Focusable ──────────────────────────────────────────────────────────
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	// ── State helpers ──────────────────────────────────────────────────────

	private get prompt(): string {
		if (this.busy) return "... ";
		return this.contBuf.length > 0 ? "... " : ">>> ";
	}

	private pushClosed(kind: EntryKind, text: string): void {
		this.history.push({ kind, text, closed: true });
	}

	/**
	 * Append a stream chunk (stdout / stderr). Coalesces with the previous
	 * entry of the same kind if it isn't yet terminated by a newline so the
	 * scrollback always has one entry per visible line.
	 */
	private appendStream(kind: "out" | "err", chunk: string): void {
		if (!chunk) return;

		const last = this.history[this.history.length - 1];
		let combined: string;
		if (last && last.kind === kind && !last.closed) {
			combined = last.text + chunk;
			this.history.pop();
		} else {
			combined = chunk;
		}

		const lines = combined.split("\n");
		// Closed lines (every segment except the last)
		for (let i = 0; i < lines.length - 1; i++) {
			this.history.push({ kind, text: lines[i], closed: true });
		}
		// Last segment is "open" until a newline arrives
		const tail = lines[lines.length - 1];
		if (tail !== "" || lines.length === 1) {
			this.history.push({ kind, text: tail, closed: false });
		}
	}

	private clearInput(): void {
		this.input.setValue("");
		this.cmdHistoryIdx = -1;
		this.cmdHistoryDraft = "";
	}

	private cancelMultiline(): void {
		if (this.contBuf.length > 0) {
			this.pushClosed("warn", "KeyboardInterrupt");
			this.contBuf = [];
		}
		this.clearInput();
		this.tui.requestRender();
	}

	private exit(): void {
		if (this.closed) return;
		this.closed = true;
		this.onDone();
	}

	// ── Input dispatch ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.closed) return;

		// Ctrl+C: interrupt (busy) or clear current line/multiline (idle).
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.busy) {
				this.kernel.interrupt();
				this.pushClosed("warn", "^C — interrupting...");
				this.tui.requestRender();
				return;
			}
			this.cancelMultiline();
			return;
		}

		// Ctrl+D: exit (only when current line is empty AND no pending multiline).
		if (matchesKey(data, Key.ctrl("d"))) {
			if (!this.busy && this.input.getValue() === "" && this.contBuf.length === 0) {
				this.pushClosed("info", "");
				this.exit();
				return;
			}
			// Otherwise behave like clearing the line.
			this.clearInput();
			this.tui.requestRender();
			return;
		}

		// Esc: exit (Input also forwards onEscape → this.exit, but matching
		// here lets us short-circuit even mid-multiline).
		if (matchesKey(data, Key.escape)) {
			this.exit();
			return;
		}

		// While the kernel is running a cell we lock out editing entirely so
		// users don't accidentally submit follow-up lines into the void.
		if (this.busy) return;

		// Up / Down: command history navigation. Only intercept when there's
		// history to navigate and the input is on its first/only line (Input
		// is single-line, so that's always true).
		if (matchesKey(data, Key.up)) {
			if (this.cmdHistory.length === 0) return;
			if (this.cmdHistoryIdx === -1) {
				this.cmdHistoryDraft = this.input.getValue();
				this.cmdHistoryIdx = this.cmdHistory.length - 1;
			} else if (this.cmdHistoryIdx > 0) {
				this.cmdHistoryIdx--;
			}
			this.input.setValue(this.cmdHistory[this.cmdHistoryIdx] ?? "");
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.cmdHistoryIdx === -1) return;
			if (this.cmdHistoryIdx < this.cmdHistory.length - 1) {
				this.cmdHistoryIdx++;
				this.input.setValue(this.cmdHistory[this.cmdHistoryIdx] ?? "");
			} else {
				this.cmdHistoryIdx = -1;
				this.input.setValue(this.cmdHistoryDraft);
				this.cmdHistoryDraft = "";
			}
			this.tui.requestRender();
			return;
		}

		// Everything else: hand off to the Input.
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	// ── Submission ─────────────────────────────────────────────────────────

	private async submitLine(line: string): Promise<void> {
		if (this.closed || this.busy) return;

		// Special-case `:q` on a fresh prompt as an exit alias.
		if (this.contBuf.length === 0 && line.trim() === ":q") {
			this.input.setValue("");
			this.exit();
			return;
		}

		// Echo the typed line into scrollback before doing anything else.
		const isContinuation = this.contBuf.length > 0;
		this.pushClosed(isContinuation ? "cont" : "in", line);
		this.contBuf.push(line);
		this.input.setValue("");
		this.cmdHistoryIdx = -1;
		this.cmdHistoryDraft = "";
		this.tui.requestRender();

		const buffer = this.contBuf.join("\n");

		// An entirely-blank submission inside a multi-line block forces
		// execution (matches Python REPL behavior). Outside a block, blank
		// lines do nothing.
		const isForcedExec = isContinuation && line.trim() === "";
		if (!isForcedExec && buffer.trim() === "") {
			this.contBuf = [];
			this.tui.requestRender();
			return;
		}

		// Ask the runner whether the accumulated buffer is a complete statement.
		let status: "complete" | "incomplete" | "error" = "complete";
		let compileError = "";
		if (!isForcedExec) {
			try {
				const result = await this.kernel.checkSyntax(buffer);
				status = result.status;
				compileError = result.error;
			} catch (err) {
				this.pushClosed(
					"exc",
					`pi-python: syntax check failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				this.contBuf = [];
				this.tui.requestRender();
				return;
			}
		}

		if (status === "incomplete") {
			// Wait for the next line; prompt automatically switches to `... `.
			this.tui.requestRender();
			return;
		}

		if (status === "error") {
			this.pushClosed("exc", compileError || "SyntaxError");
			this.contBuf = [];
			this.tui.requestRender();
			return;
		}

		// Complete (or forced) — execute.
		const code = buffer;
		this.contBuf = [];
		this.cmdHistory.push(code);
		await this.runCode(code);
	}

	private async runCode(code: string): Promise<void> {
		this.busy = true;
		this.tui.requestRender();

		try {
			const result = await this.kernel.execute([{ code }], {
				timeoutMs: 0, // no timeout in the interactive REPL — Ctrl+C interrupts
				cwd: this.cwd,
				onUpdate: (snapshot) => this.applySnapshot(snapshot),
			});
			this.applySnapshot(result, /*final*/ true);
		} catch (err) {
			this.pushClosed(
				"exc",
				`pi-python: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			this.busy = false;
			this.pushClosed("info", "");
			this.tui.requestRender();
		}
	}

	/** Track how much of each cell's output we've already consumed. */
	private streamCursor = { stdout: 0, stderr: 0 };
	private valueShown = false;
	private excShown = false;

	private resetCellTracking(): void {
		this.streamCursor = { stdout: 0, stderr: 0 };
		this.valueShown = false;
		this.excShown = false;
	}

	private applySnapshot(snapshot: ExecuteResult, isFinal = false): void {
		const cell = snapshot.cells[0];
		if (!cell) {
			if (isFinal) this.resetCellTracking();
			return;
		}

		// Stream new stdout / stderr deltas.
		if (cell.stdout.length > this.streamCursor.stdout) {
			this.appendStream("out", cell.stdout.slice(this.streamCursor.stdout));
			this.streamCursor.stdout = cell.stdout.length;
		}
		if (cell.stderr.length > this.streamCursor.stderr) {
			this.appendStream("err", cell.stderr.slice(this.streamCursor.stderr));
			this.streamCursor.stderr = cell.stderr.length;
		}

		// Once cell_end has arrived, surface the value or exception (each
		// once). Both fields are stable after cell_end, so a guard flag is
		// enough to dedupe across the partial + final calls.
		if (cell.value && !this.valueShown && (cell.ok || isFinal)) {
			this.pushClosed("val", cell.value);
			this.valueShown = true;
		}
		if (cell.exception && !this.excShown && (!cell.ok || isFinal)) {
			this.pushClosed("exc", cell.exception.replace(/\n+$/, ""));
			this.excShown = true;
		}

		if (snapshot.timedOut) {
			this.pushClosed("warn", "[timed out]");
		} else if (snapshot.cancelled && isFinal) {
			this.pushClosed("warn", "[cancelled]");
		}

		if (isFinal) this.resetCellTracking();
		this.tui.requestRender();
	}

	// ── Render ─────────────────────────────────────────────────────────────

	invalidate(): void {
		// Stateless render — nothing to do, but Component requires this.
	}

	render(width: number): string[] {
		const rows = process.stdout.rows ?? 40;
		// Reserve: header (1) + separator (1) + input line (1) + footer (1).
		const reserved = 4;
		const scrollHeight = Math.max(3, rows - reserved);

		const lines: string[] = [];

		// Header
		lines.push(this.renderDivider(width, "Python REPL"));

		// Scrollback — keep only the most recent entries that fit. We render
		// each entry as exactly one line (truncated if too wide) so we don't
		// have to worry about wrapping pushing the prompt off-screen.
		const visible = this.history.slice(-scrollHeight);
		// Pad with blank lines at the top so the prompt stays anchored to the
		// bottom even when scrollback is short.
		const padding = Math.max(0, scrollHeight - visible.length);
		for (let i = 0; i < padding; i++) lines.push("");
		for (const entry of visible) {
			lines.push(this.renderEntry(entry, width));
		}

		// Input line: prompt + Input.render()
		const promptRaw = this.prompt;
		const promptWidth = visibleWidth(promptRaw);
		const promptStyled = this.busy
			? this.theme.fg("muted", promptRaw)
			: this.theme.fg("accent", promptRaw);
		const inputLines = this.input.render(Math.max(1, width - promptWidth));
		const firstInputLine = inputLines[0] ?? "";
		lines.push(promptStyled + firstInputLine);

		// Footer hint
		const hint = this.busy
			? "running… Ctrl+C interrupts · Esc/Ctrl+D exit"
			: "Esc / Ctrl+D / :q exit · ↑↓ history · Ctrl+C clear line";
		lines.push(this.theme.fg("dim", truncateToWidth(hint, width, "")));

		return lines;
	}

	private renderDivider(width: number, label: string): string {
		const info = this.kernel.getInfo();
		const subtitle = info ? ` · pid ${info.pid}` : "";
		const text = `── ${label}${subtitle} `;
		const remaining = Math.max(0, width - visibleWidth(text));
		return this.theme.fg("muted", text + "─".repeat(remaining));
	}

	private renderEntry(entry: Entry, width: number): string {
		const text = entry.text;
		switch (entry.kind) {
			case "in":
				return truncateToWidth(this.theme.fg("accent", ">>> ") + text, width, "");
			case "cont":
				return truncateToWidth(this.theme.fg("accent", "... ") + text, width, "");
			case "out":
				return truncateToWidth(text, width, "");
			case "err":
				return truncateToWidth(this.theme.fg("warning", text), width, "");
			case "val":
				return truncateToWidth(text, width, "");
			case "exc":
				return truncateToWidth(this.theme.fg("error", text), width, "");
			case "warn":
				return truncateToWidth(this.theme.fg("warning", text), width, "");
			case "info":
				return truncateToWidth(this.theme.fg("muted", text), width, "");
			default:
				return truncateToWidth(text, width, "");
		}
	}
}
