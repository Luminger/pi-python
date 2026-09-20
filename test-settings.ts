import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

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

const root = mkdtempSync(join(tmpdir(), "pi-python-settings-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(home, { recursive: true });
mkdirSync(cwd, { recursive: true });

const previous = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
	// Import only after setting the environment: settings.ts resolves its global
	// paths once at module load, exactly as it does when pi starts.
	const settings = await import(`./settings.ts?test=${Date.now()}`);
	const legacy = join(home, ".pi", "pi-python", "settings.json");
	const global = join(agentDir, "pi-python", "settings.json");
	const extensionTree = join(agentDir, "extensions", "pi-python", "settings.json");

	console.log("\n[1] paths follow pi's config roots");
	check(settings.GLOBAL_SETTINGS_FILE === global, "global path uses PI_CODING_AGENT_DIR");
	check(
		settings.projectSettingsFileFor(cwd) === join(cwd, ".pi", "pi-python", "settings.json"),
		"project path uses CONFIG_DIR_NAME",
	);
	check(settings.GLOBAL_SETTINGS_FILE !== extensionTree, "settings never live inside extension code");

	console.log("\n[2] legacy global settings migrate once");
	mkdirSync(join(home, ".pi", "pi-python"), { recursive: true });
	writeFileSync(legacy, JSON.stringify({ maxTimeoutSeconds: 17 }));
	const migrationWarnings: string[] = [];
	settings.migrateLegacyGlobalSettings(migrationWarnings, legacy, global);
	const migrated = settings.loadSettings({ cwd, env: {} });
	check(!existsSync(legacy), "legacy file was moved");
	check(existsSync(global), "new global file exists");
	check(migrated.values.maxTimeoutSeconds === 17, "migrated value is active");
	check(migrated.sources.maxTimeoutSeconds === "global", "migrated value reports global source");
	check(
		migrationWarnings.some((warning: string) => warning.includes("migrated settings")),
		"migration is reported",
	);

	console.log("\n[3] project and environment precedence stay intact");
	const project = settings.projectSettingsFileFor(cwd);
	mkdirSync(join(cwd, ".pi", "pi-python"), { recursive: true });
	writeFileSync(project, JSON.stringify({ maxTimeoutSeconds: 23 }));
	const projectResult = settings.loadSettings({ cwd, env: {} });
	check(projectResult.values.maxTimeoutSeconds === 23, "project overrides global");
	check(projectResult.sources.maxTimeoutSeconds === "project", "project source is reported");
	const envResult = settings.loadSettings({
		cwd,
		env: { PI_PYTHON_MAX_TIMEOUT_SECONDS: "31" },
	});
	check(envResult.values.maxTimeoutSeconds === 31, "environment overrides project");
	check(envResult.sources.maxTimeoutSeconds === "env", "environment source is reported");

	console.log("\n[4] an existing new file is never overwritten");
	writeFileSync(global, JSON.stringify({ maxTimeoutSeconds: 41 }));
	mkdirSync(join(home, ".pi", "pi-python"), { recursive: true });
	writeFileSync(legacy, JSON.stringify({ maxTimeoutSeconds: 99 }));
	settings.migrateLegacyGlobalSettings([], legacy, global);
	const existing = settings.loadSettings({ cwd: undefined, env: {} });
	check(existing.values.maxTimeoutSeconds === 41, "new global file wins");
	check(existsSync(legacy), "legacy file remains when destination already exists");
	check(JSON.parse(readFileSync(global, "utf8")).maxTimeoutSeconds === 41, "destination was not modified");
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n══ ${passed} passed · ${failed} failed ══`);
if (failed > 0) process.exit(1);
