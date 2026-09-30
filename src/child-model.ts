import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveWorkerModel } from "./model.ts";

function resolveBareModel(registry: ModelRegistry, spec: string) {
	const matches = registry.getAll().filter(model => model.id === spec);
	if (matches.length === 1) return matches[0];
	const available = registry.getAvailable().filter(model => model.id === spec);
	return available.length === 1 ? available[0] : undefined;
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
