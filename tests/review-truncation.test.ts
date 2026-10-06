import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { registerPrReviewTool } from "../src/tools/pr-review.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

for (const scenario of ["short", "review-long", "final-long", "verify-failed", "errors-long"]) {
	test(`PR review tracks truncation: ${scenario}`, async (t) => {
		t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
		t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
			const verify = JSON.stringify(context).includes("VERIFY and AGGREGATE");
			const failed = scenario === "errors-long" || (scenario === "verify-failed" && verify);
			const long = scenario === (verify ? "final-long" : "review-long") || scenario === "verify-failed";
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: failed ? [] : [{ type: "text", text: long ? "界".repeat(10000) : "No findings." }],
				stopReason: failed ? "error" : "stop",
				errorMessage: failed ? "error".repeat(5000) : undefined,
				timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			if (failed) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: "stop", message });
			return stream;
		});
		const registry = {
			find: (provider: string, id: string) => ({
				provider, id, api: "openai-completions", name: id, reasoning: false, input: ["text"],
				contextWindow: 64000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
		assert.equal(result.details.truncated, scenario !== "short");
		assert.ok(Buffer.byteLength(result.content[0].text) < 12500);
		assert.ok(!result.content[0].text.includes("�"));
	});
}
