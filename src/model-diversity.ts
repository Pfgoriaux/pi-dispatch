import { sameModelId } from "./roster.ts";

/** Claude accounts and the Aperture prefix count as one voice; Opus and Astra do not. */
export const modelIdentity = sameModelId;

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
