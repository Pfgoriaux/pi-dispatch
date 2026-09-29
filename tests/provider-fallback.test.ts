import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { withProviderFallbacks, type RankedCandidate } from "../src/roster.ts";
import { runWorker } from "../src/worker.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";

const codexSol = "openai-codex/gpt-6.1-sol";
const synthetic = "aperture/synthetic/hf:moonshotai/Kimi-K3";
const neuralwatt = "aperture/neuralwatt/kimi-k3";
const agent: AgentConfig = {
	name: "fallback-fixture", description: "test", tools: [], model: synthetic,
	thinking: "high", systemPrompt: "fixture", source: "bundled", filePath: "fixture",
};
const candidate = (modelSpec: string): RankedCandidate => ({
	modelSpec, thinking: "high", entry: { provider: "", model: modelSpec, thinking: "high", weight: 1 },
});

for (const prefix of ["", "aperture/"]) {
	for (const [id, counterpart] of [["hf:moonshotai/Kimi-K3", "kimi-k3"]]) {
		test(`${prefix}Synthetic ${id} retries Neuralwatt then Codex 6.1 Sol once`, () => {
			const first = `${prefix}synthetic/${id}`;
			const routes = withProviderFallbacks([candidate(first)]);
			assert.deepEqual(routes.map(c => c.modelSpec), [first, `aperture/neuralwatt/${counterpart}`, codexSol]);
			assert.ok(routes.every(c => c.thinking === "high"));
			assert.deepEqual(withProviderFallbacks(routes), routes);
		});
	}
}

test("explicit counterpart effort survives fallback expansion in either direction", () => {
	for (const [first, second] of [[neuralwatt, synthetic], [synthetic, neuralwatt]]) {
		const configured = { ...candidate(second), thinking: "off", entry: { ...candidate(second).entry, thinking: "off" } };
		const routes = withProviderFallbacks([candidate(first), configured]);
		assert.equal(routes[1], configured);
		assert.deepEqual(withProviderFallbacks(routes), routes);
	}
});

test("6.1 Sol stays last across model families and explicit duplicates", () => {
	const routes = withProviderFallbacks([candidate(neuralwatt), candidate(codexSol), candidate("neuralwatt/glm-5.3"), candidate(synthetic)]);
	assert.equal(routes.at(-1)?.modelSpec, codexSol);
	assert.equal(routes.filter(c => c.modelSpec === codexSol).length, 1);
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

for (const first of [synthetic, neuralwatt]) {
	for (const allFail of [false, true]) {
		test(`SDK ${first}: exhausted credits ${allFail ? "stop after 6.1 Sol" : "recover on 6.1 Sol"}`, { timeout: 10000 }, async (t) => {
			t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
			const calls: string[] = [];
			t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>) => {
				const selected = `${model.provider}/${model.id}`;
				calls.push(selected);
				const failed = allFail || selected !== codexSol;
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: failed ? [] : [{ type: "text", text: "RECOVERED" }],
					stopReason: failed ? "error" : "stop", errorMessage: failed ? "402 insufficient credits" : undefined,
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
			const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, modelSpec: first });
			assert.deepEqual(calls, [first, first === synthetic ? neuralwatt : synthetic, codexSol]);
			assert.equal(result.status, allFail ? "error" : "ok");
			assert.equal(result.model, codexSol);
			assert.equal(result.attempts, 3);
			assert.equal(result.usage?.totalTokens, 6);
			if (allFail) assert.match(result.error!, /402 insufficient credits/);
			else assert.equal(result.text, "RECOVERED");
		});
	}
}

for (const scenario of ["recover", "exhaust", "tools-started", "abort", "child-abort"] as const) {
	test(`child credit fallback: ${scenario}`, async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-fallback-"));
		const bin = path.join(dir, "fake-pi");
		const previous = process.env.PI_DISPATCH_PI_BIN;
		t.after(() => {
			if (previous === undefined) delete process.env.PI_DISPATCH_PI_BIN;
			else process.env.PI_DISPATCH_PI_BIN = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		});
		fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const failed = ${JSON.stringify(scenario)} !== "recover" || model !== ${JSON.stringify(codexSol)};
if (${JSON.stringify(scenario)} === "tools-started") console.log(JSON.stringify({type: "tool_execution_start", toolName: "write"}));
console.log(JSON.stringify({type: "message_end", message: {
 role: "assistant", model, stopReason: ${JSON.stringify(scenario)} === "child-abort" ? "aborted" : failed ? "error" : "stop",
 errorMessage: failed ? "402 insufficient credits" : undefined,
 content: failed ? [] : [{type: "text", text: "RECOVERED"}],
 usage: {input: 1, output: 1, totalTokens: 2}
}}));
process.exitCode = failed ? 1 : 0;
`, { mode: 0o700 });
		process.env.PI_DISPATCH_PI_BIN = bin;
		const calls: string[] = [];
		const controller = new AbortController();
		const result = await runWorkerProc(agent, "test", {
			cwd: dir, signal: controller.signal,
			onAttempt: (model, thinking, attempt) => {
				calls.push(model);
				assert.equal(thinking, "high");
				assert.equal(attempt, calls.length);
				if (scenario === "abort") controller.abort();
			},
		});
		const aborted = scenario === "abort" || scenario === "child-abort";
		const stopsEarly = scenario === "tools-started" || aborted;
		assert.deepEqual(calls, stopsEarly ? [synthetic] : [synthetic, neuralwatt, codexSol]);
		assert.equal(result.attempts, calls.length);
		assert.equal(result.status, scenario === "recover" ? "ok" : aborted ? "aborted" : "error");
		assert.equal(result.model, calls.at(-1));
		if (scenario !== "abort") assert.equal(result.usage?.totalTokens, calls.length * 2);
	});
}

// Top-tier model pairing tests (Opus 5.5 ↔ Astra 6)
const opus = "anthropic/claude-opus-5-5";
const astra = "openai-codex/gpt-6-astra";

test("top-tier Opus 5.5 adds Astra counterpart then 6.1 Sol fallback", () => {
	const routes = withProviderFallbacks([candidate(opus)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [opus, astra, codexSol]);
	assert.ok(routes.every(c => c.thinking === "high"));
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

test("top-tier Astra adds Opus counterpart then 6.1 Sol fallback", () => {
	const routes = withProviderFallbacks([candidate(astra)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [astra, opus, codexSol]);
	assert.ok(routes.every(c => c.thinking === "high"));
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

test("explicit top-tier counterpart effort survives fallback expansion", () => {
	for (const [first, second] of [[opus, astra], [astra, opus]]) {
		const configured = { ...candidate(second), thinking: "off", entry: { ...candidate(second).entry, thinking: "off" } };
		const routes = withProviderFallbacks([candidate(first), configured]);
		assert.equal(routes[1], configured);
		assert.deepEqual(withProviderFallbacks(routes), routes);
	}
});

// Mid-tier pairing (Sonnet 5.5 → Sol 6.1)

const sonnet = "anthropic/claude-sonnet-5-5";

test("mid-tier Sonnet 5.5 adds Sol 6.1 once; Sol never expands to Sonnet", () => {
	const routes = withProviderFallbacks([candidate(sonnet)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [sonnet, codexSol]);
	assert.deepEqual(withProviderFallbacks(routes), routes);
	assert.deepEqual(withProviderFallbacks([candidate(codexSol)]).map(c => c.modelSpec), [codexSol]);
});

test("Sonnet ahead of other families keeps Sol as the single last fallback", () => {
	const routes = withProviderFallbacks([candidate(sonnet), candidate(opus)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [sonnet, opus, astra, codexSol]);
});

test("mixed top-tier and NeuralWatt/Synthetic get appropriate counterparts", () => {
	const routes = withProviderFallbacks([candidate(opus), candidate(neuralwatt)]);
	// Opus → Astra, NeuralWatt → Synthetic, then 6.1 Sol
	assert.ok(routes.some(c => c.modelSpec === opus));
	assert.ok(routes.some(c => c.modelSpec === astra));
	assert.ok(routes.some(c => c.modelSpec === neuralwatt));
	assert.ok(routes.some(c => c.modelSpec === synthetic));
	assert.equal(routes.at(-1)?.modelSpec, codexSol);
});

test("excluded peer is skipped on failover and the failed attempt is reported", { timeout: 10000 }, async (t) => {
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	const calls: string[] = [];
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>) => {
		const selected = `${model.provider}/${model.id}`;
		calls.push(selected);
		const failed = selected === astra;
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text: "REVIEWED" }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? "402 insufficient credits" : undefined,
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
	const result = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: astra, excludeModels: [opus],
	});
	assert.deepEqual(calls, [astra, codexSol]);
	assert.equal(result.status, "ok");
	assert.equal(result.model, codexSol);
	assert.deepEqual(result.failedAttempts, [`${astra}: 402 insufficient credits`]);
});
