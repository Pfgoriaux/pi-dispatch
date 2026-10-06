import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { ModelRuntime, type ExtensionAPI, type ExtensionContext, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import dispatchExtension from "../src/index.ts";
import { registerCouncilTool } from "../src/tools/council.ts";
import type { DispatchDetails } from "../src/types.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

function setup(t: TestContext, answer: (spec: string) => string | undefined = spec => `Opinion from ${spec}`, errorMessage = "402 insufficient credits") {
	const calls: { spec: string; context: string }[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		const spec = `${model.provider}/${model.id}`;
		calls.push({ spec, context: JSON.stringify(context) });
		const text = answer(spec);
		const failed = text === undefined;
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? errorMessage : undefined,
			timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
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
	let tool: ToolDefinition | undefined;
	registerCouncilTool({ registerTool: (value: ToolDefinition) => { tool = value; } } as unknown as ExtensionAPI);
	const ctx = {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	} as ExtensionContext;
	const run = async (params: Record<string, unknown> = {}, signal?: AbortSignal) => {
		const result = await tool!.execute("test", {
			question: "Choose A or B", context: "Evidence: A is simpler.", herdr: false, ...params,
		}, signal, undefined, ctx);
		return { ...result, details: result.details as DispatchDetails };
	};
	return { calls, run, registry };
}

test("council is registered alongside existing workflows", () => {
	const names: string[] = [];
	dispatchExtension({
		on: () => {},
		registerTool: (tool: ToolDefinition) => names.push(tool.name),
	} as unknown as ExtensionAPI);
	assert.ok(names.includes("council"));
});

test("three distinct opinions see the same task, not each other's answers; no fourth call", async (t) => {
	const dir = path.join(process.env.PI_CODING_AGENT_DIR!, "agents");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "advisor.md");
	fs.writeFileSync(file, "---\nname: advisor\ndescription: Custom advisor\ntools: bash, edit, write, dispatch\n---\nGive an opinion.");
	t.after(() => fs.rmSync(file));
	const { calls, run } = setup(t);
	const result = await run();
	assert.deepEqual(calls.map(call => call.spec).sort(), [
		"anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra", "aperture/neuralwatt/glm-5.3",
	].sort());
	for (const call of calls) {
		assert.match(call.context, /Choose A or B/);
		assert.match(call.context, /Evidence: A is simpler/);
		assert.ok(!call.context.includes("Opinion from"));
		const toolNames = JSON.parse(call.context).tools.map((tool: { name: string }) => tool.name);
		for (const forbidden of ["bash", "edit", "write", "dispatch", "council", "feature_plan", "pr_review"])
			assert.ok(!toolNames.includes(forbidden), forbidden);
	}
	assert.equal(result.details.items.length, 3);
	assert.equal(result.details.aggregated, false);
	assert.equal(result.usage?.cost.total, 0.03);
	assert.match(JSON.stringify(result.content), /3\/3 opinions/);
});

test("failed seats never borrow another seat or Sol; GLM may retry its other provider", async (t) => {
	const { calls, run } = setup(t, spec => spec === "synthetic/hf:zai-org/GLM-5.3" ? "Only GLM answered" : undefined);
	const result = await run();
	assert.equal(calls.length, 4);
	assert.equal(result.details.items.filter(item => item.status === "ok").length, 1);
	assert.equal(result.details.items[2].model, "synthetic/hf:zai-org/GLM-5.3");
	assert.equal(result.details.items[2].attempts, 2);
	assert.equal(result.usage?.cost.total, 0.04);
	const text = JSON.stringify(result.content);
	assert.match(text, /1\/3 opinions/);
	assert.match(text, /Failed attempts/);
	assert.ok(!calls.some(call => call.spec.includes("sol")));
});

test("Kimi replaces GLM and retries only Kimi's provider counterpart", async (t) => {
	const { calls, run } = setup(t, spec => spec === "aperture/neuralwatt/kimi-k3" ? undefined : "Answer");
	const result = await run({ third: "kimi-k3" });
	assert.equal(result.details.items[2].model, "aperture/synthetic/hf:moonshotai/Kimi-K3");
	assert.equal(calls.length, 4);
	assert.ok(!calls.some(call => /glm|sol/.test(call.spec)));
});

test("all failures are explicit, output is capped, and cancellation starts no requests", async (t) => {
	let mode: "fail" | "long" = "fail";
	const { calls, run } = setup(t, () => mode === "fail" ? undefined : "界".repeat(10000));
	const failure = await run();
	assert.match(JSON.stringify(failure.content), /0\/3 opinions/);
	mode = "long";
	const long = await run();
	assert.equal(long.details.truncated, true);
	for (const block of long.content) {
		if (block.type === "text") assert.ok(Buffer.byteLength(block.text) < 12500);
	}
	const before = calls.length;
	const aborted = await run({}, AbortSignal.abort());
	assert.match(JSON.stringify(aborted.content), /Council aborted/);
	assert.ok(aborted.details.items.every(item => item.status === "aborted"));
	assert.equal(calls.length, before);
	await assert.rejects(run({ question: "  " }), /must not be blank/);
	assert.equal(calls.length, before);
});

test("model allowlist checks resolved identity, not just the requested spec", async (t) => {
	const { calls, run, registry } = setup(t);
	t.mock.method(registry, "find", (provider: string, id: string) => ({
		provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-completions",
		name: `${provider}/${id}`, reasoning: false, input: ["text"], contextWindow: 32000,
		maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	const result = await run();
	assert.equal(calls.length, 0);
	assert.match(JSON.stringify(result.content), /0\/3 opinions/);
});

test("long fallback errors cannot erase the successful opinion", async (t) => {
	const { run } = setup(t, spec => spec === "aperture/neuralwatt/glm-5.3" ? undefined : "PRESERVED-OPINION", "x".repeat(20000));
	const result = await run();
	const third = result.content[3];
	assert.equal(third.type, "text");
	if (third.type !== "text") return;
	assert.match(third.text, /PRESERVED-OPINION/);
	assert.match(third.text, /Failed attempts/);
	assert.ok(Buffer.byteLength(third.text) < 1500);
	assert.equal(result.details.truncated, true);
});

test("cancellation during a model request settles every seat without new fallback calls", async (t) => {
	const controller = new AbortController();
	const { run, calls } = setup(t, () => {
		controller.abort();
		return undefined;
	});
	const result = await run({}, controller.signal);
	assert.match(JSON.stringify(result.content), /Council aborted/);
	assert.ok(result.details.items.every(item => item.status === "aborted"));
	assert.ok(calls.length > 0 && calls.length <= 3);
	assert.ok(!calls.some(call => call.spec.includes("synthetic")));
});

test("a quota-exhausted Opus seat remains unavailable rather than borrowing Astra", async (t) => {
	const cache = path.join(process.env.PI_CODING_AGENT_DIR!, "cache", "usage-bar");
	fs.mkdirSync(cache, { recursive: true });
	const file = path.join(cache, "claude-v3.json");
	fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), limits: [{ label: "week", remaining: 0, unit: "%" }] }));
	t.after(() => fs.rmSync(file));
	const { run, calls } = setup(t);
	const result = await run();
	assert.equal(calls.length, 2);
	assert.ok(!calls.some(call => call.spec.startsWith("anthropic")));
	assert.equal(result.details.items[0].attempts, 0);
	assert.equal(result.details.items[0].status, "error");
	assert.match(JSON.stringify(result.content), /2\/3 opinions/);
});
