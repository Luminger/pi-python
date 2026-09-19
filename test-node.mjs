import { spawnSync } from "node:child_process";

// --experimental-transform-types provides parameter-property lowering on
// Node 22/24. Node 26 removed the flag after making transformation the default.
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const args = [
	...(major < 26 ? ["--experimental-transform-types"] : []),
	"--no-warnings",
	"test-interrupt.ts",
];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
