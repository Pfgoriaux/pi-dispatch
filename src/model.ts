/**
 * Worker model runtime sharing. Reimplements the proven pattern from
 * aliou/pi-harness agent-kit (createSubagentModelRuntime):
 *
 * A fresh ModelRuntime does not know providers that were registered by
 * extensions in the *parent* pi process (proxies, custom gateways). To let
 * in-process workers use those models we copy the native provider
 * registration and the resolved credential into the worker runtime.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	CredentialSynchronizationError,
	type ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const providerRuntimes = new Map<string, Promise<ModelRuntime>>();

export function sharedModelRuntime(
	registry: ModelRegistry,
	model: Model,
): Promise<ModelRuntime> {
	const existing = providerRuntimes.get(model.provider);
	if (existing) return existing;

	const created = (async () => {
		const runtime = await ModelRuntime.create();
		const nativeProvider =
			registry.getRegisteredNativeProvider(model.provider);
		if (nativeProvider) {
			runtime.registerNativeProvider(nativeProvider);
		}
		const apiKey = await registry.getApiKeyForProvider(model.provider);
		if (apiKey && !registry.isUsingOAuth(model)) {
			try {
				await runtime.setRuntimeApiKey(model.provider, apiKey);
			} catch (error) {
				// The credential is committed to the runtime overlay even when
				// this throws; only an opportunistic catalog refresh failed.
				if (!(error instanceof CredentialSynchronizationError)) throw error;
			}
		}
		return runtime;
	})();

	providerRuntimes.set(model.provider, created);
	return created;
}

/** Resolve a model spec ("provider/id", "inherit", undefined) to a Model. */
export function resolveWorkerModel(
	registry: ModelRegistry,
	spec: string | undefined,
	fallback: Model | undefined,
): Model | undefined {
	if (!spec || spec === "inherit" || spec === "") return fallback;
	const slash = spec.indexOf("/");
	if (slash === -1) {
		// Bare model id: search every provider's catalogue.
		return (
			registry.getAll().find((m) => m.id === spec) ??
			registry.getAvailable().find((m) => m.id === spec) ??
			undefined
		);
	}
	return (
		registry.find(spec.slice(0, slash), spec.slice(slash + 1)) ?? undefined
	);
}
