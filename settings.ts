/**
 * pi-python settings.
 *
 * pi's built-in `Settings` schema is strongly typed and has no slot for
 * arbitrary extension config, so we keep our own JSON file under pi's global
 * and project config roots:
 *
 *   ${PI_CODING_AGENT_DIR}/pi-python/settings.json  (global)
 *   <cwd>/${CONFIG_DIR_NAME}/pi-python/settings.json (project, overrides global)
 *
 * `PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`; `CONFIG_DIR_NAME` defaults
 * to `.pi`. The old global location (`~/.pi/pi-python/settings.json`) is
 * migrated once, on load, when it exists and the new file does not.
 *
 * Both files are optional. Missing fields fall back to the lower-precedence
 * source. Malformed JSON is ignored (a warning surfaces in /python-status)
 * with the rest of the extension still functional.
 *
 * Precedence (highest wins):
 *   1. Environment variable (e.g. PI_PYTHON_MAX_TIMEOUT_SECONDS)
 *   2. Project settings.json
 *   3. Global settings.json
 *   4. Built-in default
 *
 * Settings are reloaded on every `loadSettings()` call (no caching), so
 * editing either file or exporting an env var takes effect on the next
 * kernel spawn without restarting pi.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Agent config dir — respects PI_CODING_AGENT_DIR, defaults to ~/.pi/agent. */
export const AGENT_DIR = getAgentDir();

/** Global settings live under pi's config root, never inside extension code. */
export const PI_PYTHON_DIR = join(AGENT_DIR, "pi-python");
export const GLOBAL_SETTINGS_FILE = join(PI_PYTHON_DIR, "settings.json");

/** Pre-`extensions/` location, moved to GLOBAL_SETTINGS_FILE on first load. */
export const LEGACY_GLOBAL_SETTINGS_FILE = join(homedir(), ".pi", "pi-python", "settings.json");

/** Where the project settings file lives, given a working directory. */
export function projectSettingsFileFor(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "pi-python", "settings.json");
}

export interface PiPythonSettings {
	/**
	 * When auto-resolving the python interpreter (no --python override, no
	 * `python_set_interpreter` set), walk from `cwd` upward looking for a
	 * venv directory listed in `venvDirNames`. Stops at the first match.
	 * Walks through repo subdirs and stops at the directory containing
	 * `.git` so we never cross repo boundaries. When false, only `cwd`
	 * itself is checked (the historical behaviour).
	 *
	 * Default: true. Lets pi started under `<repo>/<subdir>/<sub>/` pick
	 * up `<repo>/<subdir>/.venv` (or `<repo>/.venv`) automatically —
	 * canonical for uv-workspace layouts where the venv lives at the
	 * workspace root, not next to every member.
	 */
	venvParentWalk: boolean;
	/**
	 * Directory names checked at each level when auto-resolving the
	 * interpreter. A user-provided list FULLY OVERWRITES the default —
	 * if you set this, the defaults (`.venv`, `venv`) are not appended.
	 * Set to `[]` to disable venv autodiscovery entirely (you'd then
	 * rely on `$VIRTUAL_ENV` / `$PI_PYTHON` / `--python` / fall through
	 * to `python3` on PATH).
	 *
	 * Default: [".venv", "venv"].
	 */
	venvDirNames: string[];
	/**
	 * Upper bound (seconds) the `python` tool's `timeout` parameter is
	 * clamped to. The agent can ask for shorter, but never longer. Use
	 * this to allow very long running cells (data pulls, training, etc.)
	 * without editing the extension.
	 *
	 * Default: 3600 (1 hour).
	 */
	maxTimeoutSeconds: number;
	/**
	 * Grace period (milliseconds) after the timeout fires before the
	 * kernel is hard-killed. The host always sends SIGINT first; the
	 * runner catches KeyboardInterrupt and wraps up the cell cleanly
	 * (preserving the namespace and any state the cell did populate).
	 * SIGKILL is the fallback for genuinely wedged kernels (C extensions
	 * that ignore signals, etc.) — it costs the namespace, which is
	 * unrecoverable, so give slow-but-alive cells room to finish.
	 *
	 * Default: 30000 (30 seconds).
	 */
	interruptGraceMs: number;
	/**
	 * Kernel memory (MB) above which every `python` result carries a warning
	 * telling the agent to free memory or restart the kernel. Measured as the
	 * kernel's cgroup `memory.current` when it runs in its own scope (see
	 * `memoryMaxMB`), else its RSS. 0 disables the warning.
	 *
	 * Default: 1024.
	 */
	memoryWarnMB: number;
	/**
	 * Hard memory limit (MB) for the kernel. On Linux with a systemd user
	 * manager the kernel is started in its own transient scope
	 * (`systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0`), so a
	 * runaway kernel is OOM-killed on its own instead of dragging the whole
	 * machine into a global OOM. Elsewhere it is started directly and the limit
	 * is not enforced (/python-status says so). 0 disables the limit.
	 *
	 * Default: 4096.
	 */
	memoryMaxMB: number;
	/**
	 * `oom_score_adj` for the kernel (and children it starts), so that under
	 * global memory pressure the kernel is picked before longer-lived services.
	 * Raising the value needs no privilege; lowering it below the parent's does
	 * and is not attempted. Range 0..1000; 0 leaves it unchanged.
	 *
	 * Default: 500.
	 */
	oomScoreAdj: number;
}

export const DEFAULT_SETTINGS: PiPythonSettings = {
	venvParentWalk: true,
	venvDirNames: [".venv", "venv"],
	maxTimeoutSeconds: 3600,
	interruptGraceMs: 30_000,
	memoryWarnMB: 1024,
	memoryMaxMB: 4096,
	oomScoreAdj: 500,
};

export type SettingSource = "default" | "global" | "project" | "env";

export interface SettingsSources {
	venvParentWalk: SettingSource;
	venvDirNames: SettingSource;
	maxTimeoutSeconds: SettingSource;
	interruptGraceMs: SettingSource;
	memoryWarnMB: SettingSource;
	memoryMaxMB: SettingSource;
	oomScoreAdj: SettingSource;
}

export interface ResolvedSettings {
	values: PiPythonSettings;
	sources: SettingsSources;
	/**
	 * Where each settings file was looked up — for /python-status.
	 */
	paths: { global: string; project: string | null };
	/** Errors encountered while loading; surfaced in /python-status, never thrown. */
	warnings: string[];
}

/**
 * Resolve effective settings from JSON files + environment variables.
 *
 * No caching, safe to call repeatedly. Cost is two stats + up to two parses.
 * Side effect: the first call after an upgrade may move the legacy global
 * file under pi's agent config directory (best-effort, warning on failure).
 */
export function loadSettings(opts?: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}): ResolvedSettings {
	const env = opts?.env ?? process.env;
	const cwd = opts?.cwd;

	const values: PiPythonSettings = {
		...DEFAULT_SETTINGS,
		// Defensive copy so caller mutations can't poison subsequent
		// loadSettings() calls via the shared DEFAULT_SETTINGS reference.
		venvDirNames: [...DEFAULT_SETTINGS.venvDirNames],
	};
	const sources: SettingsSources = {
		venvParentWalk: "default",
		venvDirNames: "default",
		maxTimeoutSeconds: "default",
		interruptGraceMs: "default",
		memoryWarnMB: "default",
		memoryMaxMB: "default",
		oomScoreAdj: "default",
	};
	const warnings: string[] = [];
	const projectFile = cwd ? projectSettingsFileFor(cwd) : null;

	// One-shot move of the pre-`extensions/` global file, so existing users
	// keep their config without an ongoing legacy read path.
	const legacyPresent = migrateLegacyGlobalSettings(warnings);

	// Apply files in precedence order: global first (so project can override).
	applyFile(GLOBAL_SETTINGS_FILE, "global", values, sources, warnings);
	// Only if the migration above could not run (rename failed): the legacy
	// file is still the effective global config.
	const legacyUsed = legacyPresent && !existsSync(GLOBAL_SETTINGS_FILE);
	if (legacyUsed) {
		applyFile(LEGACY_GLOBAL_SETTINGS_FILE, "global", values, sources, warnings);
	}
	if (projectFile) applyFile(projectFile, "project", values, sources, warnings);

	// Env var beats files.
	const envWalk = env.PI_PYTHON_VENV_PARENT_WALK;
	if (envWalk !== undefined && envWalk !== "") {
		const parsed = parseBoolean(envWalk);
		if (parsed !== null) {
			values.venvParentWalk = parsed;
			sources.venvParentWalk = "env";
		} else {
			warnings.push(
				`PI_PYTHON_VENV_PARENT_WALK=${JSON.stringify(envWalk)} is not a boolean (true/false/1/0)`,
			);
		}
	}

	const envDirNames = env.PI_PYTHON_VENV_DIR_NAMES;
	if (envDirNames !== undefined) {
		// Comma-separated; empty-but-set means "no dir names" (disable
		// autodiscovery). To use the default, leave the env var unset.
		const parts = envDirNames
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		values.venvDirNames = parts;
		sources.venvDirNames = "env";
	}

	const envMaxTimeout = env.PI_PYTHON_MAX_TIMEOUT_SECONDS;
	if (envMaxTimeout !== undefined && envMaxTimeout !== "") {
		const parsed = parsePositiveInteger(envMaxTimeout);
		if (parsed !== null) {
			values.maxTimeoutSeconds = parsed;
			sources.maxTimeoutSeconds = "env";
		} else {
			warnings.push(
				`PI_PYTHON_MAX_TIMEOUT_SECONDS=${JSON.stringify(envMaxTimeout)} is not a positive integer`,
			);
		}
	}

	const envGrace = env.PI_PYTHON_INTERRUPT_GRACE_MS;
	if (envGrace !== undefined && envGrace !== "") {
		const parsed = parseNonNegativeInteger(envGrace);
		if (parsed !== null) {
			values.interruptGraceMs = parsed;
			sources.interruptGraceMs = "env";
		} else {
			warnings.push(
				`PI_PYTHON_INTERRUPT_GRACE_MS=${JSON.stringify(envGrace)} is not a non-negative integer`,
			);
		}
	}

	for (const [key, name, max] of INTEGER_ENV) {
		const raw = env[name];
		if (raw === undefined || raw === "") continue;
		const parsed = parseNonNegativeInteger(raw);
		if (parsed !== null && parsed <= max) {
			values[key] = parsed;
			sources[key] = "env";
		} else {
			warnings.push(`${name}=${JSON.stringify(raw)} is not an integer in 0..${max}`);
		}
	}

	return {
		values,
		sources,
		paths: {
			// Point /python-status at whichever file is actually effective.
			global: legacyUsed ? LEGACY_GLOBAL_SETTINGS_FILE : GLOBAL_SETTINGS_FILE,
			project: projectFile,
		},
		warnings,
	};
}

/** Non-negative integer settings that share one parser: key, env var, upper bound. */
const INTEGER_ENV: ReadonlyArray<readonly ["memoryWarnMB" | "memoryMaxMB" | "oomScoreAdj", string, number]> = [
	["memoryWarnMB", "PI_PYTHON_MEMORY_WARN_MB", Number.MAX_SAFE_INTEGER],
	["memoryMaxMB", "PI_PYTHON_MEMORY_MAX_MB", Number.MAX_SAFE_INTEGER],
	["oomScoreAdj", "PI_PYTHON_OOM_SCORE_ADJ", 1000],
];

/**
 * Move ~/.pi/pi-python/settings.json under pi's agent config directory when
 * the old file exists and the new one does not. Best-effort: any failure is a
 * warning, never fatal. Returns whether the legacy file was present.
 */
export function migrateLegacyGlobalSettings(
	warnings: string[],
	legacyFile = LEGACY_GLOBAL_SETTINGS_FILE,
	globalFile = GLOBAL_SETTINGS_FILE,
): boolean {
	if (!existsSync(legacyFile)) return false;
	if (existsSync(globalFile)) return true;
	try {
		mkdirSync(dirname(globalFile), { recursive: true });
		renameSync(legacyFile, globalFile);
		warnings.push(`migrated settings: ${legacyFile} -> ${globalFile}`);
	} catch (err) {
		warnings.push(
			`could not move ${legacyFile} to ${globalFile} ` +
				`(${err instanceof Error ? err.message : String(err)}); still reading the legacy location`,
		);
	}
	return true;
}

function applyFile(
	path: string,
	source: "global" | "project",
	values: PiPythonSettings,
	sources: SettingsSources,
	warnings: string[],
): void {
	if (!existsSync(path)) return;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		warnings.push(
			`${source} settings (${path}): parse failed (${err instanceof Error ? err.message : String(err)}); ignored`,
		);
		return;
	}

	if (!raw || typeof raw !== "object") {
		warnings.push(`${source} settings (${path}): top-level value must be a JSON object`);
		return;
	}
	const obj = raw as Record<string, unknown>;

	const fileWalk = obj.venvParentWalk;
	if (typeof fileWalk === "boolean") {
		values.venvParentWalk = fileWalk;
		sources.venvParentWalk = source;
	} else if (fileWalk !== undefined) {
		warnings.push(
			`${source} settings (${path}): venvParentWalk must be a boolean, got ${JSON.stringify(fileWalk)}`,
		);
	}

	const fileDirNames = obj.venvDirNames;
	if (Array.isArray(fileDirNames)) {
		const cleaned: string[] = [];
		let bad = false;
		for (const entry of fileDirNames) {
			if (typeof entry === "string" && entry.length > 0) {
				cleaned.push(entry);
			} else {
				bad = true;
				break;
			}
		}
		if (bad) {
			warnings.push(
				`${source} settings (${path}): venvDirNames must be an array of non-empty strings, got ${JSON.stringify(fileDirNames)}`,
			);
		} else {
			// Full overwrite — user's list is the list, defaults are not appended.
			values.venvDirNames = cleaned;
			sources.venvDirNames = source;
		}
	} else if (fileDirNames !== undefined) {
		warnings.push(
			`${source} settings (${path}): venvDirNames must be an array of strings, got ${JSON.stringify(fileDirNames)}`,
		);
	}

	const fileMaxTimeout = obj.maxTimeoutSeconds;
	if (typeof fileMaxTimeout === "number" && Number.isFinite(fileMaxTimeout) && fileMaxTimeout > 0) {
		values.maxTimeoutSeconds = Math.floor(fileMaxTimeout);
		sources.maxTimeoutSeconds = source;
	} else if (fileMaxTimeout !== undefined) {
		warnings.push(
			`${source} settings (${path}): maxTimeoutSeconds must be a positive number, got ${JSON.stringify(fileMaxTimeout)}`,
		);
	}

	const fileGrace = obj.interruptGraceMs;
	if (typeof fileGrace === "number" && Number.isFinite(fileGrace) && fileGrace >= 0) {
		values.interruptGraceMs = Math.floor(fileGrace);
		sources.interruptGraceMs = source;
	} else if (fileGrace !== undefined) {
		warnings.push(
			`${source} settings (${path}): interruptGraceMs must be a non-negative number, got ${JSON.stringify(fileGrace)}`,
		);
	}

	for (const [key, , max] of INTEGER_ENV) {
		const v = obj[key];
		if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max) {
			values[key] = Math.floor(v);
			sources[key] = source;
		} else if (v !== undefined) {
			warnings.push(
				`${source} settings (${path}): ${key} must be a number in 0..${max}, got ${JSON.stringify(v)}`,
			);
		}
	}
}

function parseBoolean(raw: string): boolean | null {
	const v = raw.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(v)) return true;
	if (["false", "0", "no", "off"].includes(v)) return false;
	return null;
}

function parsePositiveInteger(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n;
}

function parseNonNegativeInteger(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}
