import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { registerPrReviewTool } from "../src/tools/pr-review.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();
// Rosters that prefer Neuralwatt for every pr_review agent.
const glmFirst = [{ provider: "aperture", model: "neuralwatt/glm-5.3", weight: 9 }];
fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings"), { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings/subagent-models.json"), JSON.stringify({
	reviewer: glmFirst, "slop-reviewer": glmFirst, scout: glmFirst,
}));

test("pr_review ignores agent rosters; only the spec + reuse seat runs GLM", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
	});
	const models: string[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>) => {
		models.push(`${model.provider}/${model.id}`);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [{ type: "text", text: "None" }], stopReason: "stop", timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	const registry = {
		find: (provider: string, id: string) => ({
			provider, id, api: "openai-completions", name: id, reasoning: true, input: ["text"],
			contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
		getRegisteredNativeProvider: () => undefined,
		getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
	let tool: any;
	registerPrReviewTool({
		registerTool: (value: unknown) => { tool = value; },
		exec: async () => ({ code: 0, stdout: "diff --git a/test b/test\n", stderr: "", killed: false }),
	} as unknown as ExtensionAPI);
	const result = await tool.execute("test", { pr: "main...HEAD", herdr: false }, undefined, undefined, {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	});
	assert.equal(result.details.items.length, 6);
	assert.equal(models.length, 6);
	assert.deepEqual(models.filter(m => !/^(anthropic|openai-codex)\//.test(m)), ["aperture/neuralwatt/glm-5.3"]);
});
