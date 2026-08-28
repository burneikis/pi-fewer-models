import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "fewer-models.json";

export interface FewerModelsConfig {
	/** Master switch. Set false to leave the catalogue untouched. */
	enabled?: boolean;
	/** Provider id globs to keep. Absent/empty means "all providers". */
	providers?: string[];
	/** Provider id globs to drop. Applied after `providers`. */
	excludeProviders?: string[];
	/** Model globs to keep, matched on `provider/id` and on bare `id`. Absent/empty means "all models". */
	allow?: string[];
	/** Model globs to drop. Applied last, wins over `allow`. */
	deny?: string[];
	/** Never hide the model that is currently selected. */
	keepCurrentModel?: boolean;
	/** Drop models whose provider has no usable credentials. */
	requireAuth?: boolean;
}

export const DEFAULT_CONFIG: FewerModelsConfig = {
	enabled: true,
	keepCurrentModel: true,
	requireAuth: false,
};

export interface LoadedConfig {
	config: FewerModelsConfig;
	/** Config files actually read, in precedence order (later wins). */
	sources: string[];
}

function readJson(path: string): FewerModelsConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as FewerModelsConfig) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Global config (`~/.pi/agent/fewer-models.json`) overlaid with the
 * project-local one (`<cwd>/<configDir>/fewer-models.json`) when trusted.
 */
export function loadConfig(cwd: string, configDirName: string, projectTrusted: boolean): LoadedConfig {
	const candidates = [join(homedir(), ".pi", "agent", CONFIG_FILE_NAME)];
	if (projectTrusted) candidates.push(join(cwd, configDirName, CONFIG_FILE_NAME));

	let config: FewerModelsConfig = { ...DEFAULT_CONFIG };
	const sources: string[] = [];
	for (const path of candidates) {
		const loaded = readJson(path);
		if (!loaded) continue;
		config = { ...config, ...loaded };
		sources.push(path);
	}
	return { config, sources };
}

/** Glob to RegExp. `*` matches inside a segment, `**` matches across `/`. */
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			continue;
		}
		out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, "i");
}

export function matchesAny(value: string | string[], patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	const values = Array.isArray(value) ? value : [value];
	return patterns.some((pattern) => {
		const regex = globToRegExp(pattern);
		return values.some((candidate) => regex.test(candidate));
	});
}

export interface ModelIdentity {
	provider: string;
	id: string;
}

/** Decide whether a model survives the configured filters. */
export function isModelKept(model: ModelIdentity, config: FewerModelsConfig): boolean {
	const { provider, id } = model;
	const qualified = `${provider}/${id}`;

	if (config.providers?.length && !matchesAny(provider, config.providers)) return false;
	if (matchesAny(provider, config.excludeProviders)) return false;
	if (config.allow?.length && !matchesAny([qualified, id], config.allow)) return false;
	if (matchesAny([qualified, id], config.deny)) return false;
	return true;
}
