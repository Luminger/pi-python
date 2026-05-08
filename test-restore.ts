/**
 * End-to-end test for branch-walk checkpoint restore.
 *
 * Drives a real pi `SessionManager` (so `getBranch()` returns the same
 * shape the extension sees in production) plus a real `PythonKernel`
 * (so checkpoint pickles are bit-for-bit what the runner writes), then
 * exercises every interesting `/tree` navigation scenario:
 *
 *   1. Leaf is a python toolResult                  → restore that pickle
 *   2. Leaf is an assistant message AFTER a result  → restore the result
 *   3. Leaf is a user message BETWEEN two results   → restore the earlier
 *   4. Leaf is on a different branch                → restore that branch's tip
 *   5. Leaf has no python ancestors                 → no restore (fresh)
 *
 * For each scenario we don't just check the resolved path — we spawn a
 * fresh kernel, restore the resolved pickle, run a cell, and assert the
 * marker variable matches what was checkpointed at that point. That
 * proves the whole pipeline (kernel.checkpoint → on-disk pickle → kernel
 * spawn → kernel.restore → namespace contains the right data) works,
 * not just the lookup.
 *
 * Run:  node test-restore.ts
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonKernel } from "./kernel.ts";
import { picklePathFor, resolveRestorePath } from "./index.ts";

// ─── tiny test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq<T>(actual: T, expected: T, label: string): void {
	if (actual === expected) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
		console.log(`  ✗ ${label}`);
		console.log(`      expected: ${expected}`);
		console.log(`      actual:   ${actual}`);
	}
}

// ─── helpers for building a fake but realistic session ──────────────────────

let timestamp = 1_700_000_000_000;
const nextTs = () => ++timestamp;

function appendUser(sm: SessionManager, text: string): string {
	return sm.appendMessage({
		role: "user",
		content: text,
		timestamp: nextTs(),
	});
}

/** Minimal-but-typecheckable assistant message with a single tool call. */
function appendAssistantToolCall(
	sm: SessionManager,
	text: string,
	toolCallId: string,
	toolName: string,
	args: unknown,
): string {
	return sm.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: toolName, arguments: args },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: nextTs(),
	} as any);
}

function appendAssistantText(sm: SessionManager, text: string): string {
	return sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: nextTs(),
	} as any);
}

function appendToolResult(
	sm: SessionManager,
	toolCallId: string,
	toolName: string,
	text: string,
): string {
	return sm.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: nextTs(),
	});
}

/** Run one cell in the kernel. Throws on failure. */
async function exec(kernel: PythonKernel, code: string): Promise<string> {
	const r = await kernel.execute([{ code }], { timeoutMs: 10_000 });
	if (r.cells[0]?.exception) throw new Error(`cell raised: ${r.cells[0].exception}`);
	return r.cells[0]?.value ?? "";
}

/**
 * Spawn a kernel, restore the pickle resolved by the lookup, run a probe
 * cell, kill. Returns whatever the probe printed, plus a trace of which
 * pickle (if any) was loaded.
 */
async function probeRestore(
	sm: SessionManager,
	probe: string,
): Promise<{ resolvedLeaf: string | null; probeValue: string }> {
	const resolvedPath = resolveRestorePath(sm);
	const resolvedLeaf = resolvedPath
		? resolvedPath.split("/").pop()?.replace(/\.pkl$/, "") ?? null
		: null;

	const k = new PythonKernel({ pythonPath: "python3", cwd: process.cwd() });
	await k.start();
	try {
		if (resolvedPath) {
			const r = await k.restore(resolvedPath);
			if (!r.ok) throw new Error(`restore failed: ${r.error}`);
		}
		const value = await exec(k, probe);
		return { resolvedLeaf, probeValue: value };
	} finally {
		await k.shutdown();
	}
}

// ─── the actual test ────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pi-python-test-"));
	const sessionDir = join(tmpRoot, "sessions");

	console.log(`tmp root: ${tmpRoot}`);

	const sm = SessionManager.create(tmpRoot, sessionDir);
	const sessionId = sm.getSessionId();
	if (!sessionId) throw new Error("session id is null");
	console.log(`session id: ${sessionId}`);

	// Spawn a kernel we'll reuse for writing checkpoints. Each scenario's
	// state is established by setting a marker variable then checkpointing
	// to picklePathFor(sessionId, toolResultId).
	const writer = new PythonKernel({ pythonPath: "python3", cwd: process.cwd() });
	await writer.start();

	const writeCheckpoint = async (toolResultId: string, marker: string) => {
		await exec(writer, `step_marker = ${JSON.stringify(marker)}`);
		const path = picklePathFor(sessionId, toolResultId);
		const result = await writer.checkpoint(path);
		if (!result.ok) throw new Error(`checkpoint failed: ${result.reason}`);
		if (!existsSync(path)) throw new Error(`pickle missing: ${path}`);
	};

	// ── Build the conversation tree ──
	//
	//   user1
	//   asst1 (calls python)
	//   tr1   ← checkpoint "alpha"
	//   asst1b (text reply)
	//   user2
	//   asst2 (calls python)
	//   tr2   ← checkpoint "beta"
	//   asst2b (text reply)
	//   user3 (no python this turn)
	//   asst3 (text only)
	//
	// Then we'll branch from asst1b to create a fork:
	//   asst1b → user4 (alt branch)
	//        → asst4 (calls python)
	//        → tr4   ← checkpoint "delta"

	const user1 = appendUser(sm, "do step 1");
	const asst1 = appendAssistantToolCall(sm, "running python", "tc-1", "python", { cells: [{ code: "x=1" }] });
	const tr1 = appendToolResult(sm, "tc-1", "python", "ok");
	await writeCheckpoint(tr1, "alpha");
	const asst1b = appendAssistantText(sm, "step 1 done");

	const user2 = appendUser(sm, "do step 2");
	const asst2 = appendAssistantToolCall(sm, "running python", "tc-2", "python", { cells: [{ code: "x=2" }] });
	const tr2 = appendToolResult(sm, "tc-2", "python", "ok");
	await writeCheckpoint(tr2, "beta");
	const asst2b = appendAssistantText(sm, "step 2 done");

	const user3 = appendUser(sm, "no python here");
	const asst3 = appendAssistantText(sm, "ack — nothing to do");

	// At this point the active leaf is asst3.
	console.log("");
	console.log("entry ids:");
	console.log(`  user1   ${user1}`);
	console.log(`  asst1   ${asst1}`);
	console.log(`  tr1     ${tr1}     (← α pickle)`);
	console.log(`  asst1b  ${asst1b}`);
	console.log(`  user2   ${user2}`);
	console.log(`  asst2   ${asst2}`);
	console.log(`  tr2     ${tr2}     (← β pickle)`);
	console.log(`  asst2b  ${asst2b}`);
	console.log(`  user3   ${user3}`);
	console.log(`  asst3   ${asst3}`);

	await writer.shutdown();

	// ─── Scenario 1: leaf = tr2 (a python toolResult itself) ─────────────────
	console.log("\n[1] leaf is a python toolResult (exact match)");
	sm.branch(tr2);
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, tr2, "resolved leaf == tr2");
		assertEq(r.probeValue, "'beta'", "marker == beta");
	}

	// ─── Scenario 2: leaf = asst2b (text reply AFTER tr2) ────────────────────
	console.log("\n[2] leaf is an assistant text msg right after tr2");
	sm.branch(asst2b);
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, tr2, "branch-walk picks tr2");
		assertEq(r.probeValue, "'beta'", "marker == beta");
	}

	// ─── Scenario 3: leaf = user2 (between tr1 and tr2) ──────────────────────
	console.log("\n[3] leaf is a user message between tr1 and tr2");
	sm.branch(user2);
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, tr1, "branch-walk picks tr1 (deepest ancestor with pickle)");
		assertEq(r.probeValue, "'alpha'", "marker == alpha");
	}

	// ─── Scenario 4: leaf = asst3, several msgs past tr2, no python in between
	console.log("\n[4] leaf is way past tr2, nothing python-y in between");
	sm.branch(asst3);
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, tr2, "branch-walk skips non-python entries to find tr2");
		assertEq(r.probeValue, "'beta'", "marker == beta");
	}

	// ─── Scenario 5: leaf = user1 (before any python call has run) ───────────
	console.log("\n[5] leaf is before any python call");
	sm.branch(user1);
	{
		const path = resolveRestorePath(sm);
		assertEq(path, null, "no checkpoint resolves (correctly)");
	}

	// ─── Scenario 6: forked branch with its own checkpoint ───────────────────
	// Branch off asst1b, do another "python call", checkpoint to "delta".
	// After branching the leaf walks tr-fork, asst-fork, user-fork, asst1b,
	// tr1, asst1, user1 — so tr-fork is the deepest pickle.
	console.log("\n[6] forked branch with its own checkpoint");
	sm.branch(asst1b);
	const userFork = appendUser(sm, "alt: do something else");
	const asstFork = appendAssistantToolCall(sm, "running python", "tc-fork", "python", { cells: [{ code: "x=99" }] });
	const trFork = appendToolResult(sm, "tc-fork", "python", "ok");
	{
		const writer2 = new PythonKernel({ pythonPath: "python3", cwd: process.cwd() });
		await writer2.start();
		try {
			await exec(writer2, `step_marker = "delta"`);
			const result = await writer2.checkpoint(picklePathFor(sessionId, trFork));
			if (!result.ok) throw new Error(`checkpoint failed: ${result.reason}`);
		} finally {
			await writer2.shutdown();
		}
	}
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, trFork, "fork tip resolves to its own pickle");
		assertEq(r.probeValue, "'delta'", "marker == delta");
	}

	// ─── Scenario 7: navigate back to original branch's leaf — confirm ───────
	// the alt-branch pickle does NOT shadow the original branch.
	console.log("\n[7] hop back to original branch — alt-branch pickle must not leak");
	sm.branch(asst3);
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, tr2, "back on original branch, β still wins");
		assertEq(r.probeValue, "'beta'", "marker == beta");
	}

	// ─── Cleanup ─────────────────────────────────────────────────────────────
	rmSync(tmpRoot, { recursive: true, force: true });

	console.log("");
	console.log(`══ ${passed} passed · ${failed} failed ══`);
	if (failed > 0) {
		console.log("");
		for (const f of failures) console.log("  ✗ " + f);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(2);
});
