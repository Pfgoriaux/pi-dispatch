import { quotaFamily } from "./roster.ts";

/** Provider aliases for the same model count as one voice; Opus and Astra do not. */
export function modelIdentity(spec: string): string {
	const route = spec.replace(/^aperture\//, "");
	if (route.startsWith("neuralwatt/") || route.startsWith("synthetic/")) {
		return quotaFamily(spec) ?? route;
	}
	return route;
}

/** One pool per parallel phase. Claims remain held after failure or completion. */
export class ModelDiversity {
	private readonly owners = new Map<string, symbol>();

	worker(): (spec: string) => boolean {
		const owner = Symbol();
		return (spec) => {
			const identity = modelIdentity(spec);
			const existing = this.owners.get(identity);
			if (existing && existing !== owner) return false;
			this.owners.set(identity, owner);
			return true;
		};
	}
}
