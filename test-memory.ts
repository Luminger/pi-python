/**
 * End-to-end test for kernel memory containment (Linux + systemd user manager).
 *
 *   1. A kernel with `memory.maxMB` runs in its own transient systemd scope
 *      with that MemoryMax, keeps its PID, and reports cgroup memory use.
 *   2. Its oom_score_adj is raised to the configured value.
 *   3. Allocating past the limit kills only the kernel, and the error names
 *      the memory limit.
 *   4. Without a limit the kernel is spawned directly and reports RSS.
 *
 * Skips (exit 0) where systemd scopes are unavailable.
 * Run:  node test-memory.ts
 */

import { readFileSync } from "node:fs";
import { PythonKernel, systemdScopeAvailable } from "./kernel.ts";

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
	if (condition) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}`);
	}
}

async function main(): Promise<void> {
	const probe = systemdScopeAvailable();
	if (!probe.ok) {
		console.log(`skipped: ${probe.reason}`);
		return;
	}
	const pythonPath = process.env.PI_PYTHON_TEST_INTERPRETER ?? "python3";

	console.log("\n[scope] limited kernel");
	const k = new PythonKernel({ pythonPath, cwd: process.cwd(), memory: { maxMB: 256, oomScoreAdj: 700 } });
	await k.start();
	try {
		const pid = k.getInfo()?.pid ?? 0;
		const limit = k.getLimit();
		check(limit?.scope !== null && limit?.maxMB === 256, `limit enforced via scope ${limit?.scope}`);
		const cg = readFileSync(`/proc/${pid}/cgroup`, "utf8");
		check(cg.includes(`${limit?.scope}.scope`), "runner pid lives in the scope (systemd-run exec'd in place)");
		const path = cg.split("\n").find((l) => l.startsWith("0::"))?.slice(3);
		const max = readFileSync(`/sys/fs/cgroup${path}/memory.max`, "utf8").trim();
		check(max === String(256 * 1024 * 1024), `memory.max is 256 MB (got ${max})`);
		const oom = readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim();
		check(oom === "700", `oom_score_adj raised to 700 (got ${oom})`);
		const mem = k.memoryUsage();
		check(mem?.source === "cgroup" && mem.bytes > 0, `memoryUsage reads the cgroup (${mem?.bytes} bytes)`);

		const ok = await k.execute([{ code: "x = 1\nx + 1" }], { timeoutMs: 5_000 });
		check(ok.cells[0]?.value === "2", "kernel works normally under the limit");

		console.log("\n[oom] allocating past the limit");
		let message = "";
		try {
			await k.execute([{ code: "blob = bytearray(600 * 1024 * 1024)\nlen(blob)" }], { timeoutMs: 30_000 });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		check(message.includes("SIGKILL"), `kernel was SIGKILLed (${message.slice(0, 60)}...)`);
		check(message.includes("256 MB kernel memory limit"), "error names the memory limit");
		check(!k.isAlive(), "kernel is dead after the OOM kill");
	} finally {
		await k.shutdown();
	}

	console.log("\n[direct] unlimited kernel");
	const u = new PythonKernel({ pythonPath, cwd: process.cwd(), memory: { maxMB: 0, oomScoreAdj: 0 } });
	await u.start();
	try {
		check(u.getLimit() === null, "no limit requested, none applied");
		check(u.memoryUsage()?.source === "rss", "memoryUsage falls back to RSS");
	} finally {
		await u.shutdown();
	}

	console.log(`\n══ ${passed} passed · ${failed} failed ══`);
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
