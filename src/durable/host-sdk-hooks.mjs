/** Module resolve hook registered by host-sdk.mjs. */
const SDK = "@earendil-works/pi-coding-agent";
let entry;

export function initialize(data) {
	entry = data.entry;
}

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (error) {
		if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
		if (specifier === SDK) return { url: entry, shortCircuit: true };
		// Thinking capability metadata must come from the same Pi installation.
		if (specifier === "@earendil-works/pi-ai") return next(specifier, { ...context, parentURL: entry });
		throw error;
	}
}
