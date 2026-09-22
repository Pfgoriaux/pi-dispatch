import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	createAssistantMessageEventStream, type Api, type AssistantMessage, type Model,
} from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runWorker } from "../src/worker.ts";
import type { AgentConfig } from "../src/types.ts";

const agent: AgentConfig = {
	name: "loop-fixture", description: "test", tools: ["read"], model: "fake/loop",
	systemPrompt: "fixture", source: "bundled", filePath: "fixture",
};
const registry = {
	find: (provider: string, id: string) => ({
		provider, id, api: "openai-completions", name: id, reasoning: false,
		input: ["text"], contextWindow: 32000, maxTokens: 2000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}),
	getRegisteredNativeProvider: () => undefined,
	getApiKeyForProvider: async () => undefined,
} as unknown as ModelRegistry;

function setup(t: TestContext, response: (model: Model<Api>, call: number) => string | undefined) {
	const previous = process.env.LINKUP_API_KEY;
	delete process.env.LINKUP_API_KEY;
	t.after(() => {
		if (previous === undefined) delete process.env.LINKUP_API_KEY;
		else process.env.LINKUP_API_KEY = previous;
	});
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	let calls = 0;
	let disposed = 0;
	const dispose = AgentSession.prototype.dispose;
	t.mock.method(AgentSession.prototype, "dispose", function (this: AgentSession) {
		disposed++; dispose.call(this);
	});
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, _context: unknown, options?: { signal?: AbortSignal }) => {
		// Like a real provider, do not issue a request once its signal is aborted.
		const aborted = options?.signal?.aborted === true;
		if (!aborted) calls++;
		// Hard fixture ceiling prevents a broken guard from hanging the test process.
		const toolName = aborted || calls > 12 ? undefined : response(model, calls);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: toolName ? [
				{ type: "text", text: "private intermediate scratch" },
				{ type: "toolCall", id: `call-${calls}`, name: toolName, arguments: {} },
			] : aborted ? [] : [{ type: "text", text: "RECOVERED" }],
			stopReason: aborted ? "aborted" : toolName ? "toolUse" : "stop", timestamp: Date.now(),
			usage: { input: aborted ? 0 : 1, output: aborted ? 0 : 1, cacheRead: 0, cacheWrite: 0, totalTokens: aborted ? 0 : 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
		else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		return stream;
	});
	return { calls: () => calls, disposed: () => disposed };
}

test("real SDK loop stops malformed calls after three, without leaking interim text or names", { timeout: 10000 }, async (t) => {
	const state = setup(t, () => "read private/path.mjs</arg_value>");
	const logs: string[] = [];
	const result = await runWorker(agent, "fixture", {
		registry, fallbackModel: undefined, modelSpec: "fake/loop", onStream: (line) => logs.push(line),
	});
	assert.equal(result.status, "error");
	assert.match(result.error!, /3 consecutive calls to unavailable tools/);
	assert.equal(result.text, "");
	assert.equal(result.attempts, 1);
	assert.equal(state.calls(), 3);
	assert.equal(state.disposed(), 1);
	assert.equal(result.usage?.totalTokens, 6);
	assert.ok(logs.some((line) => line.includes("[error]")));
	assert.ok(logs.some((line) => line.startsWith("cutoff:")));
	assert.ok(!logs.join("\n").includes("private"));
});

test("real SDK loop bounds invalid arguments to registered tools", { timeout: 10000 }, async (t) => {
	const state = setup(t, () => "read"); // Missing required path: no filesystem read.
	const result = await runWorker(agent, "fixture", { registry, fallbackModel: undefined, modelSpec: "fake/loop" });
	assert.equal(result.status, "error");
	assert.match(result.error!, /5 consecutive tool errors/);
	assert.equal(state.calls(), 5);
});

test("two malformed calls may recover without cutoff", { timeout: 10000 }, async (t) => {
	const state = setup(t, (_model, call) => call <= 2 ? "bad</arg_value>" : undefined);
	const result = await runWorker(agent, "fixture", { registry, fallbackModel: undefined, modelSpec: "fake/loop" });
	assert.equal(result.status, "ok");
	assert.equal(result.text, "RECOVERED");
	assert.equal(state.calls(), 3);
});

test("internal cutoff can fail over an explicit route and accounts for both attempts", { timeout: 10000 }, async (t) => {
	const state = setup(t, (model) => model.id.startsWith("neuralwatt/") ? "bad</arg_value>" : undefined);
	const result = await runWorker(agent, "fixture", {
		registry, fallbackModel: undefined, modelSpec: "aperture/neuralwatt/kimi-k3",
	});
	assert.equal(result.status, "ok");
	assert.equal(result.model, "aperture/synthetic/hf:moonshotai/Kimi-K3");
	assert.equal(result.text, "RECOVERED");
	assert.equal(result.attempts, 2);
	assert.equal(result.usage?.totalTokens, 8);
	assert.equal(state.calls(), 4);
	assert.equal(state.disposed(), 2);
});

test("parent cancellation wins over cutoff and never retries", { timeout: 10000 }, async (t) => {
	const state = setup(t, () => "bad</arg_value>");
	const controller = new AbortController();
	const result = await runWorker(agent, "fixture", {
		registry, fallbackModel: undefined, modelSpec: "aperture/neuralwatt/kimi-k3",
		signal: controller.signal,
		onStream: (line) => { if (line.startsWith("cutoff:")) controller.abort(); },
	});
	assert.equal(result.status, "aborted");
	assert.equal(result.attempts, 1);
	assert.equal(state.calls(), 3);
});
