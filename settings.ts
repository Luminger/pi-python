/**
 * pi-python settings.
 *
 * pi's built-in `Settings` schema is strongly typed and has no slot for
 * arbitrary extension config, so we keep our own JSON file. Two locations
 * are searched, mirroring pi's own settings.json layout:
 *
 *   ~/.pi/pi-python/settings.json          (global)
 *   <cwd>/.pi/pi-python/settings.json      (project, overrides global)
 *
 * Both files are optional. Missing fields fall back to the lower-precedence
 * source. Malformed JSON is ignored (a warning surfaces in /python-status)
 * with the rest of the extension still functional.
 *
 * Precedence (highest wins):
 *   1. Environment variable (e.g. PI_PYTHON_PICKLE_MAX_BYTES)
 *   2. Project settings.json
 *   3. Global settings.json
 *   4. Built-in default
 *
 * Settings are reloaded on every `loadSettings()` call (no caching), so
 * editing either file or exporting an env var takes effect on the next
 * checkpoint without restarting pi.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PI_PYTHON_DIR = join(homedir(), ".pi", "pi-python");
export const GLOBAL_SETTINGS_FILE = join(PI_PYTHON_DIR, "settings.json");

/** Where the project settings file lives, given a working directory. */
export function projectSettingsFileFor(cwd: string): string {
	return join(cwd, ".pi", "pi-python", "settings.json");
}

export interface PiPythonSettings {
	/** Max bytes for an automatic checkpoint pickle. Larger pickles are skipped. */
	pickleMaxBytes: number;
}

export const DEFAULT_SETTINGS: PiPythonSettings = {
	pickleMaxBytes: 256 * 1024 * 1024,
};

export type SettingSource = "default" | "global" | "project" | "env";

export interface SettingsSources {
	pickleMaxBytes: SettingSource;
}

export interface ResolvedSettings {
	values: PiPythonSettings;
	sources: SettingsSources;
	/** Where each settings file was looked up — for /python-status. */
	paths: { global: string; project: string | null };
	/** Errors encountered while loading; surfaced in /python-status, never thrown. */
	warnings: string[];
}

/**
 * Resolve effective settings from JSON files + environment variables.
 *
 * Pure: no caching, safe to call repeatedly. Cost is two stats + up to two
 * parses, negligible compared to checkpoint work.
 */
export function loadSettings(opts?: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}): ResolvedSettings {
	const env = opts?.env ?? process.env;
	const cwd = opts?.cwd;

	const values: PiPythonSettings = { ...DEFAULT_SETTINGS };
	const sources: SettingsSources = { pickleMaxBytes: "default" };
	const warnings: string[] = [];
	const projectFile = cwd ? projectSettingsFileFor(cwd) : null;

	// Apply files in precedence order: global first (so project can override).
	applyFile(GLOBAL_SETTINGS_FILE, "global", values, sources, warnings);
	if (projectFile) applyFile(projectFile, "project", values, sources, warnings);

	// Env var beats files.
	const envBytes = env.PI_PYTHON_PICKLE_MAX_BYTES;
	if (envBytes !== undefined && envBytes !== "") {
		const parsed = parsePositiveInteger(envBytes);
		if (parsed !== null) {
			values.pickleMaxBytes = parsed;
			sources.pickleMaxBytes = "env";
		} else {
			warnings.push(
				`PI_PYTHON_PICKLE_MAX_BYTES=${JSON.stringify(envBytes)} is not a positive integer`,
			);
		}
	}

	return {
		values,
		sources,
		paths: { global: GLOBAL_SETTINGS_FILE, project: projectFile },
		warnings,
	};
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

	const fileBytes = obj.pickleMaxBytes;
	if (typeof fileBytes === "number" && Number.isFinite(fileBytes) && fileBytes > 0) {
		values.pickleMaxBytes = Math.floor(fileBytes);
		sources.pickleMaxBytes = source;
	} else if (fileBytes !== undefined) {
		warnings.push(
			`${source} settings (${path}): pickleMaxBytes must be a positive number, got ${JSON.stringify(fileBytes)}`,
		);
	}
}

function parsePositiveInteger(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n;
}
