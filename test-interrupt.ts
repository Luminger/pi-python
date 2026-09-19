/**
 * End-to-end test for SIGINT-safe kernel behaviour.
 *
 * Drives a real PythonKernel through the relevant failure scenarios and
 * verifies that the selected interpreter receives the host environment
 * unchanged:
 *   0. An ordinary Python exception is reported as a cell failure without
 *      killing the kernel. State created before the exception — including
 *      mutations earlier in the failed cell itself — remains available.
 *   1. A long-running cell is interrupted by `timeoutMs` → the cell
 *      reports timedOut+cancelled, and the kernel STAYS ALIVE. State
 *      established by previous cells in the same execute() call survives
 *      (the runner's SIGINT-safe signal handling kicks in around each
 *      cell's exec/eval and the namespace persists).
 *   2. After the interrupted call, a follow-up execute() works against
 *      the same kernel without respawning.
 *   3. With `interruptGraceMs: 0` and a cell that traps KeyboardInterrupt,
 *      we verify the kernel is NOT hard-killed — instead the cell
 *      completes via the user's handler and the call returns cleanly.
 *
 * Run:  node test-interrupt.ts
 */

import { PythonKernel } from "./kernel.ts";

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
	const envMarker = "inherited-from-pi-host";
	const k = new PythonKernel({
		pythonPath: "python3",
		cwd: process.cwd(),
		env: { ...process.env, PI_PYTHON_ENV_INHERITANCE_TEST: envMarker },
	});
	await k.start();
	const initialPid = k.getInfo()?.pid;
	if (!initialPid) throw new Error("no initial pid");
	console.log(`kernel up (pid ${initialPid})`);

	try {
		console.log("\n[env] host environment is inherited unchanged");
		const inheritedEnv = await k.execute(
			[{ code: "import os\nos.environ['PI_PYTHON_ENV_INHERITANCE_TEST']" }],
			{ timeoutMs: 5_000 },
		);
		check(
			inheritedEnv.cells[0]?.value === `'${envMarker}'`,
			`custom host variable is visible (got ${JSON.stringify(inheritedEnv.cells[0]?.value)})`,
		);

		// ── 0. Ordinary exception: same process and namespace survive ──
		console.log("\n[0] ordinary exception preserves the kernel and namespace");
		const ordinaryFailure = await k.execute(
			[
				{
					code: [
						"ordinary_marker = ['created']",
						"ordinary_marker.append('mutated before failure')",
						"raise RuntimeError('intentional test failure')",
					].join("\n"),
				},
			],
			{ timeoutMs: 5_000 },
		);
		check(ordinaryFailure.cells[0]?.ok === false, "ordinary exception reports ok=false");
		check(
			(ordinaryFailure.cells[0]?.exception ?? "").includes("RuntimeError: intentional test failure"),
			"ordinary exception includes its traceback",
		);
		check(k.isAlive(), "kernel remains alive after an ordinary exception");
		check(k.getInfo()?.pid === initialPid, `pid unchanged (${k.getInfo()?.pid})`);

		const afterOrdinaryFailure = await k.execute(
			[{ code: "ordinary_marker" }],
			{ timeoutMs: 5_000 },
		);
		check(
			afterOrdinaryFailure.cells[0]?.value === "['created', 'mutated before failure']",
			`failed-cell mutations preserved (got ${JSON.stringify(afterOrdinaryFailure.cells[0]?.value)})`,
		);

		// ── 1. Multi-cell timeout: marker set, then long sleep gets SIGINT'd ──
		console.log("\n[1] multi-cell call where cell 2 times out");
		const r1 = await k.execute(
			[
				{ code: "marker='alpha'\nprint('marker set')" },
				{ code: "import time\nfor _ in range(100): time.sleep(0.1)\n" },
				{ code: "marker='omega'  # never runs" },
			],
			{ timeoutMs: 500, interruptGraceMs: 5_000 },
		);

		check(r1.timedOut, "result.timedOut === true");
		check(r1.cancelled, "result.cancelled === true");
		check(r1.cellsRun === 2, `cellsRun is 2 (set marker + interrupted sleep), got ${r1.cellsRun}`);
		check(r1.cells[0]?.ok === true, "cell 0 (set marker) succeeded");
		const cell0Stdout = r1.cells[0]?.stdout ?? "";
		check(cell0Stdout.includes("marker set"), `cell 0 printed 'marker set' (got ${JSON.stringify(cell0Stdout)})`);
		check(r1.cells[1]?.ok === false, "cell 1 (sleep) ok=false");
		check(
			(r1.cells[1]?.exception ?? "").includes("KeyboardInterrupt"),
			"cell 1 exception mentions KeyboardInterrupt",
		);

		// ── 2. Kernel still alive after the interrupted call ──
		console.log("\n[2] kernel survives the interrupt");
		check(k.isAlive(), "k.isAlive() === true after timeout");
		const pidAfter = k.getInfo()?.pid;
		check(pidAfter === initialPid, `same pid (${pidAfter} === ${initialPid})`);

		// ── 3. Marker preserved ──
		console.log("\n[3] namespace state from before-the-interrupt cell preserved");
		const r2 = await k.execute([{ code: "marker" }], { timeoutMs: 10_000 });
		check(r2.cells[0]?.ok === true, "follow-up cell succeeded");
		check(
			r2.cells[0]?.value === "'alpha'",
			`marker preserved (got ${JSON.stringify(r2.cells[0]?.value)})`,
		);

		// ── 4. SIGINT-trapping cell still doesn't kill the kernel even with
		//      interruptGraceMs: 0. The runner's SIG_IGN-by-default keeps it
		//      alive between cells; the cell itself catches KeyboardInterrupt
		//      and reports normally.
		console.log("\n[4] cell that traps KeyboardInterrupt + zero grace");
		const r3 = await k.execute(
			[
				{
					code: [
						"import time",
						"try:",
						"    for _ in range(100):",
						"        time.sleep(0.05)",
						"except KeyboardInterrupt:",
						"    pass",
						"print('finished gracefully')",
						"survival_marker = 'beta'",
					].join("\n"),
				},
			],
			{ timeoutMs: 500, interruptGraceMs: 0 },
		);
		// Cell-level SIGINT is caught inside the `try:` so the cell completes
		// successfully; the timedOut flag still reflects that the wall clock
		// expired.
		check(r3.timedOut, "result.timedOut still true (timer fired)");
		check(k.isAlive(), "kernel still alive with interruptGraceMs: 0");
		check(
			r3.cells[0]?.ok === true,
			`cell ok=true (caught its own KeyboardInterrupt): ok=${r3.cells[0]?.ok}, exc=${JSON.stringify(r3.cells[0]?.exception)}`,
		);
		check(
			(r3.cells[0]?.stdout ?? "").includes("finished gracefully"),
			"cell printed 'finished gracefully'",
		);

		const r4 = await k.execute([{ code: "survival_marker" }], { timeoutMs: 5_000 });
		check(
			r4.cells[0]?.value === "'beta'",
			`survival_marker preserved (got ${JSON.stringify(r4.cells[0]?.value)})`,
		);

		// ── 5. Same pid still — never hard-killed ──
		console.log("\n[5] still the same kernel pid throughout");
		check(k.getInfo()?.pid === initialPid, `pid unchanged (${k.getInfo()?.pid})`);
	} finally {
		await k.shutdown();
	}

	// ── 6. Uninterruptible cell → hard kill preserves partial output ──
	//
	// Regression test for the only failure mode that ever showed up in real
	// sessions: a cell wedged in something SIGINT can't reach (here, a
	// Python-level handler that swallows every KeyboardInterrupt, standing
	// in for a C extension). It used to reject the whole call with the bare
	// string "python kernel killed", discarding everything the cell had
	// printed. It must now resolve with that output plus killed=true.
	console.log("\n[6] uninterruptible cell: hard kill keeps partial output");
	const k2 = new PythonKernel({ pythonPath: "python3", cwd: process.cwd() });
	await k2.start();
	const pid2 = k2.getInfo()?.pid;
	try {
		const r6 = await k2.execute(
			[
				{
					code: [
						"import time, sys",
						"print('findings: 3 hosts reachable', flush=True)",
						"deadline = time.time() + 30",
						"while time.time() < deadline:",
						"    try:",
						"        time.sleep(0.05)",
						"    except KeyboardInterrupt:",
						"        pass  # swallow it, like a C ext that never checks signals",
					].join("\n"),
				},
			],
			{ timeoutMs: 500, interruptGraceMs: 1_500 },
		);

		check(r6.killed === true, `result.killed === true (got ${r6.killed})`);
		check(r6.timedOut, "result.timedOut === true");
		check(
			(r6.cells[0]?.stdout ?? "").includes("findings: 3 hosts reachable"),
			`partial stdout survived the kill (got ${JSON.stringify(r6.cells[0]?.stdout)})`,
		);
		check(!k2.isAlive(), "kernel is dead after the hard kill");

		// And the next call must transparently respawn into a fresh namespace.
		const r7 = await k2.execute([{ code: "'respawned'" }], { timeoutMs: 5_000 });
		check(r7.cells[0]?.value === "'respawned'", "next execute() respawns the kernel");
		check(k2.getInfo()?.pid !== pid2, `respawn has a new pid (${pid2} -> ${k2.getInfo()?.pid})`);
	} finally {
		await k2.shutdown();
	}

	console.log(`\n══ ${passed} passed · ${failed} failed ══`);
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
