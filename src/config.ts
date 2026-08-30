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
	/** Keep only the newest version(s) of each model family (haiku-4-5 wins over haiku-4). */
	hideOldModels?: boolean;
	/** How many versions per family to keep when `hideOldModels` is on. Default 1. */
	keepVersions?: number;
	/** Model globs that are never treated as old. */
	keepAlways?: string[];
}

export const DEFAULT_CONFIG: FewerModelsConfig = {
	enabled: true,
	keepCurrentModel: true,
	requireAuth: false,
	hideOldModels: false,
	keepVersions: 1,
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

// ---------------------------------------------------------------------------
// Old-version pruning
// ---------------------------------------------------------------------------

interface ParsedModelId {
	/** Everything that is not a version number, e.g. `claude-haiku` for `claude-haiku-4-5`. */
	family: string;
	/** Version components in order, e.g. `[4, 5]` for `claude-haiku-4-5` and `claude-haiku-4.5`. */
	version: number[];
	/** True when the id carries a release date such as `-20251001`. */
	dated: boolean;
}

/** `20251001`, `2025-10-01` and `2025_10_01` all mark a dated release. */
const DATE_PATTERN = /(?:^|(?<=[-_\s]))(?:\d{4}[-_]\d{2}[-_]\d{2}|\d{6,})(?=$|[-_\s])/g;
/** `4`, `v4`, `4.1` */
const VERSION_PATTERN = /^v?(\d+(?:\.\d+)*)$/i;
/** `4o`, `4.1o` - a version with a letter suffix that belongs to the family. */
const VERSION_THEN_WORD_PATTERN = /^v?(\d+(?:\.\d+)*)([a-z]+)$/i;
/** `o1`, `o3` - a family prefix glued to its version. */
const WORD_THEN_VERSION_PATTERN = /^([a-z]+)(\d+(?:\.\d+)*)$/i;

/** Split a model id into a family name, a version tuple, and a date marker. */
export function parseModelId(id: string): ParsedModelId {
	const words: string[] = [];
	const version: number[] = [];
	let dated = false;

	// Strip dates first: `2024-05-13` must not be read as version 2024.5.13.
	const undated = id.replace(DATE_PATTERN, () => {
		dated = true;
		return "";
	});

	const pushVersion = (value: string) => {
		for (const part of value.split(".")) version.push(Number(part));
	};

	for (const token of undated.split(/[-_\s]+/)) {
		if (token === "") continue;

		const plain = VERSION_PATTERN.exec(token);
		if (plain) {
			pushVersion(plain[1]);
			continue;
		}

		const suffixed = VERSION_THEN_WORD_PATTERN.exec(token);
		if (suffixed) {
			pushVersion(suffixed[1]);
			words.push(suffixed[2].toLowerCase());
			continue;
		}

		const prefixed = WORD_THEN_VERSION_PATTERN.exec(token);
		if (prefixed) {
			words.push(prefixed[1].toLowerCase());
			pushVersion(prefixed[2]);
			continue;
		}

		words.push(token.toLowerCase());
	}

	return { family: words.join("-"), version, dated };
}

function compareVersions(a: number[], b: number[]): number {
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const diff = (a[i] ?? -1) - (b[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Keep only the newest `keepVersions` releases per model family.
 * Undated ids win over dated ones at the same version (`haiku-4-5` over `haiku-4-5-20251001`).
 */
export function pruneOldModels<T extends ModelIdentity>(models: T[], config: FewerModelsConfig): T[] {
	if (!config.hideOldModels) return models;
	const keepVersions = Math.max(1, config.keepVersions ?? 1);

	const families = new Map<string, { model: T; parsed: ParsedModelId }[]>();
	const exempt: T[] = [];

	for (const model of models) {
		if (matchesAny([`${model.provider}/${model.id}`, model.id], config.keepAlways)) {
			exempt.push(model);
			continue;
		}
		const parsed = parseModelId(model.id);
		if (parsed.version.length === 0) {
			exempt.push(model);
			continue;
		}
		const key = `${model.provider}\u0000${parsed.family}`;
		const bucket = families.get(key) ?? [];
		bucket.push({ model, parsed });
		families.set(key, bucket);
	}

	const kept = new Set<T>(exempt);
	for (const bucket of families.values()) {
		const versions = [...new Set(bucket.map((entry) => entry.parsed.version.join(".")))]
			.map((key) => key.split(".").map(Number))
			.sort((a, b) => compareVersions(b, a))
			.slice(0, keepVersions);

		for (const version of versions) {
			const sameVersion = bucket.filter((entry) => compareVersions(entry.parsed.version, version) === 0);
			const undated = sameVersion.filter((entry) => !entry.parsed.dated);
			for (const entry of undated.length > 0 ? undated : sameVersion) kept.add(entry.model);
		}
	}

	return models.filter((model) => kept.has(model));
}
