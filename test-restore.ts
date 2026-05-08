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
import {
	checkpointDirFor,
	inheritParentCheckpoints,
	picklePathFor,
	resolveRestorePath,
} from "./index.ts";

// All session ids the test creates; their pickle dirs under PI_PYTHON_DIR
// (~/.pi/pi-python/) get rmSync'd in the cleanup block so we don't leak
// state between runs. The test session lifecycle and the on-disk pickle
// dir lifecycle are decoupled by design (so checkpoints survive a pi
// crash) — in production that's correct, but for tests it means we have
// to clean up explicitly.
const createdSessionIds: string[] = [];

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
	let tmpRoot: string | null = null;
	try {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-python-test-"));
		await runScenarios(tmpRoot);
	} finally {
		// Always tear down checkpoint dirs we created, even on assertion
		// failure or thrown error — otherwise repeated test runs leak dirs
		// under ~/.pi/pi-python/.
		if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
		for (const sid of createdSessionIds) {
			rmSync(checkpointDirFor(sid), { recursive: true, force: true });
		}
	}
}

async function runScenarios(tmpRoot: string): Promise<void> {
	const sessionDir = join(tmpRoot, "sessions");

	console.log(`tmp root: ${tmpRoot}`);

	const sm = SessionManager.create(tmpRoot, sessionDir);
	const sessionId = sm.getSessionId();
	if (!sessionId) throw new Error("session id is null");
	createdSessionIds.push(sessionId);
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

	// ─── Scenario 8: branchWithSummary — leaf is the synthetic summary ───────
	// branchWithSummary(asst1b, "…") moves the leaf to asst1b and appends a
	// branch_summary entry as its child; the summary entry becomes the new
	// leaf. The summary entry is non-message and has no pickle of its own,
	// so the walk should skip past it to asst1b (also no pickle) and land
	// on tr1's α checkpoint.
	console.log("\n[8] leaf is a branch_summary entry from /branch-with-summary");
	const summaryId = sm.branchWithSummary(asst1b, "moved on from the original path");
	console.log(`  branch summary entry: ${summaryId}`);
	{
		const branchIds = sm.getBranch().map((e) => e.id);
		assertEq(
			branchIds.includes(summaryId) && branchIds[branchIds.length - 1] === summaryId,
			true,
			"summary entry is the active leaf and appears in getBranch()",
		);
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, tr1, "walk skips branch_summary, lands on tr1");
		assertEq(r.probeValue, "'alpha'", "marker == alpha");
	}

	// ─── Scenario 9: python call appended after a branch_summary ─────────────
	// Verify the new toolResult's pickle is found correctly even though its
	// parent on the branch is a branch_summary entry rather than a normal
	// assistant/user message.
	console.log("\n[9] python call appended after a branch_summary");
	const userPost = appendUser(sm, "after the summary, do a fresh python call");
	const asstPost = appendAssistantToolCall(sm, "running", "tc-post", "python", { cells: [{ code: "x=5" }] });
	const trPost = appendToolResult(sm, "tc-post", "python", "ok");
	{
		const writer3 = new PythonKernel({ pythonPath: "python3", cwd: process.cwd() });
		await writer3.start();
		try {
			await exec(writer3, `step_marker = "epsilon"`);
			const result = await writer3.checkpoint(picklePathFor(sessionId, trPost));
			if (!result.ok) throw new Error(`checkpoint failed: ${result.reason}`);
		} finally {
			await writer3.shutdown();
		}
	}
	{
		const r = await probeRestore(sm, "step_marker");
		assertEq(r.resolvedLeaf, trPost, "new tip wins on the post-summary path");
		assertEq(r.probeValue, "'epsilon'", "marker == epsilon");
	}

	// ─── Scenario 10: forkFrom() into a fresh project, inherit pickles ─────
	// SessionManager.forkFrom copies *all* entries from the source verbatim
	// (preserving entry ids) and the new manager opens with the file's
	// trailing entry as its leaf — it does NOT carry over the parent's
	// runtime leaf. So to simulate "user forked from tr2" we explicitly
	// re-position the fork's leaf to tr2 after forkFrom, then run
	// inheritance. Inheritance walks the fork's active branch and copies
	// any parent pickle whose key matches an entry on that branch.
	console.log("\n[10] forkFrom + branch(tr2) — alpha + beta inherit");
	const parentSessionFile = sm.getSessionFile()!;
	const forkCwd = join(tmpRoot, "forked-cwd");
	const forkSessionDir = join(forkCwd, "sessions");
	const smFork = SessionManager.forkFrom(parentSessionFile, forkCwd, forkSessionDir);
	const forkSessionId = smFork.getSessionId()!;
	createdSessionIds.push(forkSessionId);
	console.log(`  fork session id: ${forkSessionId}`);
	assertEq(forkSessionId !== sessionId, true, "fork has a different session id");
	assertEq(
		existsSync(checkpointDirFor(forkSessionId)),
		false,
		"fork checkpoint dir is empty pre-inherit",
	);
	smFork.branch(tr2);
	const inherited = inheritParentCheckpoints(smFork);
	assertEq(inherited?.parentSessionId, sessionId, "inheritance reports correct parent id");
	// alpha (on path) + beta (on path) = 2 inherited.
	assertEq(inherited?.copied, 2, "copied 2 pickles (alpha + beta) from parent");
	assertEq(
		existsSync(picklePathFor(forkSessionId, tr1)),
		true,
		"α pickle landed in fork dir",
	);
	assertEq(
		existsSync(picklePathFor(forkSessionId, tr2)),
		true,
		"β pickle landed in fork dir",
	);
	// Off-branch parent pickles must NOT come along: trPost (epsilon) is
	// past tr2 in the file but not in the tr2-rooted branch.
	assertEq(
		existsSync(picklePathFor(forkSessionId, trPost)),
		false,
		"off-branch ε pickle did NOT land in fork dir",
	);
	{
		const r = await probeRestore(smFork, "step_marker");
		assertEq(r.resolvedLeaf, tr2, "fork resolves to inherited β pickle");
		assertEq(r.probeValue, "'beta'", "fork kernel shows marker == beta");
	}

	// ─── Scenario 11: forkFrom + position at tr1 — only α inherits ───────
	console.log("\n[11] forkFrom + branch(tr1) — only ancestor pickles copy");
	const forkCwd2 = join(tmpRoot, "forked-cwd-2");
	const smFork2 = SessionManager.forkFrom(parentSessionFile, forkCwd2, join(forkCwd2, "sessions"));
	const forkSessionId2 = smFork2.getSessionId()!;
	createdSessionIds.push(forkSessionId2);
	smFork2.branch(tr1);
	const inherited2 = inheritParentCheckpoints(smFork2);
	assertEq(inherited2?.parentSessionId, sessionId, "fork2 sees correct parent");
	assertEq(
		inherited2?.copied,
		1,
		"only α inherits when fork's branch stops at tr1",
	);
	assertEq(
		existsSync(picklePathFor(forkSessionId2, tr1)),
		true,
		"α pickle landed in fork2 dir",
	);
	assertEq(
		existsSync(picklePathFor(forkSessionId2, tr2)),
		false,
		"β pickle did NOT land in fork2 dir (off-branch)",
	);

	// ─── Scenario 12: inheritance is idempotent — second call is a no-op ───
	console.log("\n[12] inheritance is idempotent");
	const inheritedAgain = inheritParentCheckpoints(smFork);
	assertEq(
		inheritedAgain?.copied,
		0,
		"second inherit copies 0 (existing files never clobbered)",
	);

	// ─── Scenario 13: no parent (regular non-forked session) ───────────────
	console.log("\n[13] non-forked session: inheritance no-ops");
	assertEq(inheritParentCheckpoints(sm), null, "plain session reports no inheritance");

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
