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
		if (specifier !== SDK || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
		return { url: entry, shortCircuit: true };
	}
}
