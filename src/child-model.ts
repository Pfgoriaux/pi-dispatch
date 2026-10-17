import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveWorkerModel } from "./model.ts";
import { sameModelId } from "./roster.ts";

/**
 * A bare ID resolves when it names one model. The same model on both Claude
 * accounts is one model: pin the first account; fallbacks add the second.
 */
function resolveBareModel(registry: ModelRegistry, spec: string) {
	for (const catalog of [registry.getAll(), registry.getAvailable()]) {
		const matches = catalog.filter(model => model.id === spec);
		const identities = new Set(matches.map(model => sameModelId(`${model.provider}/${model.id}`)));
		if (identities.size !== 1) continue;
		const [identity] = identities;
		return matches.find(model => `${model.provider}/${model.id}` === identity) ?? matches[0];
	}
	return undefined;
}

/** `provider/id` for a bare ID that resolves exactly; any other spec unchanged. */
export function qualifiedSpec(registry: ModelRegistry, spec: string): string {
	if (spec.includes("/") || spec === "inherit") return spec;
	const model = resolveChildModel(registry, spec);
	return model ? `${model.provider}/${model.id}` : spec;
}

/** Resolve without catalog-order bias; reject identities the CLI cannot pin exactly. */
export function resolveChildModel(registry: ModelRegistry, spec: string | undefined) {
	if (!spec) return undefined;
	const model = spec.includes("/") ? resolveWorkerModel(registry, spec, undefined) : resolveBareModel(registry, spec);
	if (!model) return undefined;
	const prefix = `${model.provider}/`;
	if (!model.id.startsWith(prefix)) return model;
	// Pi's CLI can prefer the shorter canonical reference over this literal ID.
	return registry.find(model.provider, model.id.slice(prefix.length)) ? undefined : model;
}
