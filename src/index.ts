import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FewerModelsConfig, isModelKept, loadConfig, pruneOldModels } from "./config.ts";

interface CatalogueModel {
	id: string;
	provider: string;
	[key: string]: unknown;
}

interface FilterStats {
	total: number;
	kept: number;
	patchedProviders: string[];
	hiddenProviders: string[];
}

export default function (pi: ExtensionAPI) {
	/** Untouched catalogue, captured before the first registerProvider() call. */
	let originals: Map<string, CatalogueModel[]> | undefined;
	const patched = new Set<string>();
	let config: FewerModelsConfig = {};
	let sources: string[] = [];
	let stats: FilterStats = { total: 0, kept: 0, patchedProviders: [], hiddenProviders: [] };
	let disabledByUser = false;

	pi.registerFlag("all-models", {
		description: "Disable pi-fewer-models filtering for this run",
		type: "boolean",
		default: false,
	});

	function groupByProvider(models: CatalogueModel[]): Map<string, CatalogueModel[]> {
		const grouped = new Map<string, CatalogueModel[]>();
		for (const model of models) {
			const list = grouped.get(model.provider) ?? [];
			list.push(model);
			grouped.set(model.provider, list);
		}
		return grouped;
	}

	function captureOriginals(ctx: ExtensionContext): Map<string, CatalogueModel[]> {
		if (!originals) originals = groupByProvider(ctx.modelRegistry.getAll() as CatalogueModel[]);
		return originals;
	}

	/** Put every provider we touched back to its pre-filter state. */
	function restore(): void {
		for (const provider of patched) pi.unregisterProvider(provider);
		patched.clear();
	}

	function applyFilter(ctx: ExtensionContext): FilterStats {
		const base = captureOriginals(ctx);
		restore();

		const active = ctx.model;
		const filtering = config.enabled !== false && !disabledByUser && !pi.getFlag("all-models");

		let total = 0;
		let kept = 0;
		const patchedProviders: string[] = [];
		const hiddenProviders: string[] = [];

		for (const [provider, models] of base) {
			total += models.length;
			if (!filtering) {
				kept += models.length;
				continue;
			}

			const isActive = (model: CatalogueModel) =>
				config.keepCurrentModel !== false && active?.provider === provider && active?.id === model.id;

			const matched = models.filter((model) => {
				if (isActive(model)) return true;
				if (config.requireAuth && !ctx.modelRegistry.hasConfiguredAuth(model as never)) return false;
				return isModelKept(model, config);
			});

			const pruned = pruneOldModels(matched, config);
			const survivors = pruned.length === matched.length ? matched : matched.filter((model) => pruned.includes(model) || isActive(model));

			kept += survivors.length;
			if (survivors.length === models.length) continue;

			// Replacing `models` for an existing provider keeps its auth/baseUrl layers.
			pi.registerProvider(provider, { models: survivors as never });
			patched.add(provider);
			patchedProviders.push(provider);
			if (survivors.length === 0) hiddenProviders.push(provider);
		}

		stats = { total, kept, patchedProviders, hiddenProviders };
		return stats;
	}

	function reload(ctx: ExtensionContext): FilterStats {
		const loaded = loadConfig(ctx.cwd, CONFIG_DIR_NAME, ctx.isProjectTrusted());
		config = loaded.config;
		sources = loaded.sources;
		return applyFilter(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		const result = reload(ctx);
		if (result.kept === 0 && result.total > 0) {
			ctx.ui.notify("pi-fewer-models filtered out every model; check your config", "warning");
		}
	});

	// Restore the catalogue so /reload re-snapshots the real model list.
	pi.on("session_shutdown", async () => {
		restore();
		originals = undefined;
	});

	pi.registerCommand("fewer-models", {
		description: "Show, reload, or toggle the model catalogue filter",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "list", "hidden", "reload", "on", "off"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim() || "status";

			if (action === "on" || action === "off") {
				disabledByUser = action === "off";
				const result = applyFilter(ctx);
				ctx.ui.notify(
					`pi-fewer-models ${action}: ${result.kept}/${result.total} models visible`,
					"info",
				);
				return;
			}

			if (action === "reload") {
				const result = reload(ctx);
				ctx.ui.notify(`pi-fewer-models reloaded: ${result.kept}/${result.total} models visible`, "info");
				return;
			}

			if (action === "list" || action === "hidden") {
				const base = captureOriginals(ctx);
				const visible = new Set(
					ctx.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`),
				);
				const all = [...base.values()].flat().map((model) => `${model.provider}/${model.id}`);
				const shown = action === "list" ? all.filter((id) => visible.has(id)) : all.filter((id) => !visible.has(id));
				ctx.ui.notify(shown.length > 0 ? shown.join("\n") : "(none)", "info");
				return;
			}

			const lines = [
				`filtering: ${config.enabled !== false && !disabledByUser && !pi.getFlag("all-models") ? "on" : "off"}`,
				`models: ${stats.kept}/${stats.total} visible`,
				`patched providers: ${stats.patchedProviders.join(", ") || "(none)"}`,
				`hidden providers: ${stats.hiddenProviders.join(", ") || "(none)"}`,
				`config: ${sources.join(", ") || "(defaults, no config file found)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
