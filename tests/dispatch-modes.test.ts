import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ExtensionToolContext, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import dispatchExtension from "../src/index.ts";
import type { DispatchDetails } from "../src/types.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

function setup(t: TestContext, answer: (context: string) => string | undefined) {
	const calls: string[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		const serialized = JSON.stringify(context);
		calls.push(serialized);
		const text = answer(serialized);
		const failed = text === undefined;
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? "fixture failure" : undefined,
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
			contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
		getRegisteredNativeProvider: () => undefined,
		getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
	let tool: ToolDefinition;
	dispatchExtension({
		on() {},
		registerTool(value: ToolDefinition) { if (value.name === "dispatch") tool = value; },
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	} as ExtensionToolContext;
	const run = async (params: Record<string, unknown>) => {
		const result = await tool.execute("test", { herdr: false, ...params }, undefined, undefined, ctx);
		return {
			text: result.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
			details: result.details as DispatchDetails,
		};
	};
	return { calls, run };
}

test("single dispatch returns a report and persist/resume restores actual SDK history", async t => {
	const token = "retained-evidence-7e83";
	const { calls, run } = setup(t, context => context.includes("Recall the prior evidence") ? "recalled" : token);
	const first = await run({ agent: "scout", task: "Produce evidence", persist: true });
	assert.equal(first.details.mode, "single");
	assert.equal(first.details.items[0].status, "ok");
	const id = first.details.items[0].sessionId!;
	assert.ok(id);
	assert.ok(first.text.includes(id), "recovery identifier must be model-visible");
	assert.ok(first.text.includes(token));
	const resumed = await run({ resume: id, task: "Recall the prior evidence" });
	assert.equal(resumed.details.mode, "resume");
	assert.equal(resumed.details.items[0].status, "ok");
	assert.ok(calls.at(-1)!.includes(token), "saved assistant evidence reaches the resumed model");
	assert.ok(calls.at(-1)!.includes("Produce evidence"));
	assert.ok(resumed.text.includes(id));
	assert.match(resumed.text, /recalled/);
	await assert.rejects(run({ resume: "missing-session", task: "Continue" }), /no persisted worker session/);
});

test("chain interpolates repeated placeholders and dollar sequences literally", async t => {
	const token = "$& $' $` $$";
	const { calls, run } = setup(t, () => token);
	const result = await run({ chain: [
		{ agent: "scout", task: "First" },
		{ agent: "scout", task: "Before {previous} after {previous}" },
	] });
	assert.equal(result.details.mode, "chain");
	assert.equal(calls.length, 2);
	assert.ok(calls[1].includes(`Before ${token} after ${token}`));
	assert.equal(result.details.items[1].task, `Before ${token} after ${token}`);
	assert.ok(result.details.items.every(item => item.status === "ok"));
});

for (const scenario of ["success", "failure", "truncated"] as const) {
	test(`parallel aggregation: ${scenario}`, async t => {
		const dir = path.join(process.env.PI_CODING_AGENT_DIR!, "agents");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "aggregator.md");
		fs.writeFileSync(file, "---\nname: aggregator\ndescription: fixture\ntools: none\nmodel: fixture/aggregate\n---\nSynthesize reports.");
		t.after(() => fs.rmSync(file));
		const { calls, run } = setup(t, context => {
			if (!context.includes("Distill the following worker reports")) return "worker evidence";
			if (scenario === "failure") return undefined;
			return scenario === "truncated" ? "a" + "界".repeat(6000) : "combined findings";
		});
		const result = await run({ tasks: [
			{ agent: "scout", task: "Inspect A", model: "fixture/worker" },
			{ agent: "scout", task: "Inspect B", model: "fixture/worker" },
		] });
		assert.equal(result.details.items.length, 3);
		assert.equal(result.details.aggregated, scenario !== "failure");
		assert.equal(calls.length, 3);
		assert.ok(calls[2].includes("Inspect A"));
		assert.ok(calls[2].includes("Inspect B"));
		assert.ok(calls[2].includes("worker evidence"));
		if (scenario === "failure") {
			assert.match(result.text, /worker evidence/);
			assert.match(result.text, /Failed workers:[\s\S]*aggregator/);
			return;
		}
		if (scenario === "success") {
			assert.equal(result.text, "combined findings");
			return;
		}
		assert.equal(result.details.truncated, true);
		assert.match(result.text, /\[output truncated: \d+ bytes dropped\]$/);
		assert.equal(Buffer.byteLength(result.text.split("\n\n[output truncated:")[0]), 12 * 1024 - 2);
		assert.ok(!result.text.includes("\ufffd"), "UTF-8 code points stay intact");
	});
}
