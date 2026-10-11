import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";

export const thinkingModel = (provider = "fixture", id = "model"): Model<Api> => ({
	provider, id, baseUrl: "https://fixture.invalid", api: "openai-completions", name: id, reasoning: true, input: ["text"],
	thinkingLevelMap: { xhigh: "xhigh", max: "max" }, contextWindow: 32000, maxTokens: 2000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

/** Real SDK sessions and storage, with the provider boundary replaced. */
export function thinkingFixture(t: TestContext, modelFor = thinkingModel, answer = (_spec: string) => "fixture report") {
	const calls: { spec: string; thinking: string | undefined; context: string }[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown, options: { reasoning?: string }) => {
		const spec = `${model.provider}/${model.id}`;
		calls.push({ spec, thinking: options.reasoning, context: JSON.stringify(context) });
		const text = answer(spec);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	const registry = {
		find: modelFor, getRegisteredNativeProvider: () => undefined, getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
	return { calls, registry };
}
