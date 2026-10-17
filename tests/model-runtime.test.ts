import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { sharedModelRuntime } from "../src/model.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

function parent(native: Provider | undefined, config: ProviderConfig | undefined): ModelRegistry {
	return {
		getRegisteredNativeProvider: () => native,
		getRegisteredProviderConfig: () => config,
		getApiKeyForProvider: async () => undefined,
		isUsingOAuth: () => true,
	} as unknown as ModelRegistry;
}

test("workers copy an extension's provider config, which carries its OAuth", async t => {
	const registered: [string, ProviderConfig][] = [];
	t.mock.method(ModelRuntime.prototype, "registerProvider", (id: string, config: ProviderConfig) => { registered.push([id, config]); });
	const config = { baseUrl: "https://api.example", oauth: { name: "account 2" } } as unknown as ProviderConfig;
	await sharedModelRuntime(parent(undefined, config), { provider: "config-account" } as Model<Api>);
	assert.deepEqual(registered, [["config-account", config]]);
});

test("a native provider registration wins over its config", async t => {
	const registered: string[] = [];
	t.mock.method(ModelRuntime.prototype, "registerProvider", (id: string) => { registered.push(`config:${id}`); });
	t.mock.method(ModelRuntime.prototype, "registerNativeProvider", (provider: Provider) => { registered.push(`native:${provider.id}`); });
	const native = { id: "native-account" } as Provider;
	await sharedModelRuntime(parent(native, {} as ProviderConfig), { provider: "native-account" } as Model<Api>);
	assert.deepEqual(registered, ["native:native-account"]);
});
