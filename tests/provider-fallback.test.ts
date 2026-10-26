import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { withProviderFallbacks, type RankedCandidate } from "../src/roster.ts";
import { runWorker } from "../src/worker.ts";
import { ModelDiversity } from "../src/model-diversity.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";

import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

const codexSol = "openai-codex/gpt-6.1-sol";
const neuralwatt = "aperture/neuralwatt/kimi-k3";
const agent: AgentConfig = {
	name: "fallback-fixture", description: "test", tools: [], model: neuralwatt,
	thinking: "high", systemPrompt: "fixture", source: "bundled", filePath: "fixture",
};
const candidate = (modelSpec: string): RankedCandidate => ({
	modelSpec, thinking: "high", entry: { provider: "", model: modelSpec, thinking: "high", weight: 1 },
});

for (const prefix of ["", "aperture/"]) {
	test(`${prefix}Neuralwatt Kimi K3 falls back to Codex 6.1 Sol once`, () => {
		const first = `${prefix}neuralwatt/kimi-k3`;
		const routes = withProviderFallbacks([candidate(first)]);
		assert.deepEqual(routes.map(c => c.modelSpec), [first, codexSol]);
		assert.ok(routes.every(c => c.thinking === "high"));
		assert.deepEqual(withProviderFallbacks(routes), routes);
	});
}

test("6.1 Sol stays last across model families and explicit duplicates", () => {
	const routes = withProviderFallbacks([candidate(neuralwatt), candidate(codexSol), candidate("neuralwatt/glm-5.3")]);
	assert.equal(routes.at(-1)?.modelSpec, codexSol);
	assert.equal(routes.filter(c => c.modelSpec === codexSol).length, 1);
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

for (const allFail of [false, true]) {
	test(`SDK ${neuralwatt}: exhausted credits ${allFail ? "stop after 6.1 Sol" : "recover on 6.1 Sol"}`, { timeout: 10000 }, async (t) => {
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
				provider, id, api: "openai-completions", name: id, reasoning: true, input: ["text"],
				contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
			getRegisteredNativeProvider: () => undefined,
			getApiKeyForProvider: async () => undefined,
		} as unknown as ModelRegistry;
		const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, modelSpec: neuralwatt });
		assert.deepEqual(calls, [neuralwatt, codexSol]);
		assert.equal(result.status, allFail ? "error" : "ok");
		assert.equal(result.model, codexSol);
		assert.equal(result.attempts, 2);
		assert.equal(result.usage?.totalTokens, 4);
		if (allFail) assert.match(result.error!, /402 insufficient credits/);
		else assert.equal(result.text, "RECOVERED");
	});
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
			onAttempt: (model, thinking, attempt, requested) => {
				calls.push(model);
				assert.equal(thinking, "unknown");
				assert.equal(requested, "high");
				assert.equal(attempt, calls.length);
				if (scenario === "abort") controller.abort();
			},
		});
		const aborted = scenario === "abort" || scenario === "child-abort";
		const stopsEarly = scenario === "tools-started" || aborted;
		assert.deepEqual(calls, stopsEarly ? [neuralwatt] : [neuralwatt, codexSol]);
		assert.equal(result.attempts, calls.length);
		assert.equal(result.status, scenario === "recover" ? "ok" : aborted ? "aborted" : "error");
		assert.equal(result.model, calls.at(-1));
		if (scenario !== "abort") assert.equal(result.usage?.totalTokens, calls.length * 2);
	});
}

// Top-tier model pairing tests (Opus 5.5 ↔ Astra 6)
const opus = "anthropic/claude-opus-5-5";
const opus2 = "anthropic-2/claude-opus-5-5";
const astra = "openai-codex/gpt-6-astra";

test("top-tier Opus 5.5 tries Claude 2, then Astra, then 6.1 Sol", () => {
	const routes = withProviderFallbacks([candidate(opus)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [opus, opus2, astra, codexSol]);
	assert.ok(routes.every(c => c.thinking === "high"));
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

test("top-tier Astra adds Opus on both Claude accounts, then 6.1 Sol", () => {
	const routes = withProviderFallbacks([candidate(astra)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [astra, opus, opus2, codexSol]);
	assert.ok(routes.every(c => c.thinking === "high"));
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

test("explicit top-tier counterpart effort survives fallback expansion", () => {
	for (const [first, second] of [[opus, astra], [astra, opus]]) {
		const configured = { ...candidate(second), thinking: "off", entry: { ...candidate(second).entry, thinking: "off" } };
		const routes = withProviderFallbacks([candidate(first), configured]);
		assert.equal(routes.find(c => c.modelSpec === second), configured);
		assert.deepEqual(withProviderFallbacks(routes), routes);
	}
});

test("Aperture-prefixed Claude specs keep their single route", () => {
	assert.deepEqual(withProviderFallbacks([candidate(`aperture/${opus}`)]).map(c => c.modelSpec), [`aperture/${opus}`]);
});

test("a Claude 2 pin falls back to the first account before cross-provider peers", () => {
	const configured = { ...candidate(opus), thinking: "off", entry: { ...candidate(opus).entry, thinking: "off" } };
	const routes = withProviderFallbacks([candidate(opus2), candidate(astra), configured]);
	assert.deepEqual(routes.map(c => c.modelSpec), [opus2, opus, astra, codexSol]);
	assert.equal(routes[1], configured);
	assert.deepEqual(withProviderFallbacks(routes), routes);
});

// Mid-tier pairing (Sonnet 5.5 → Sol 6.1)

const sonnet = "anthropic/claude-sonnet-5-5";
const sonnet2 = "anthropic-2/claude-sonnet-5-5";

test("mid-tier Sonnet 5.5 tries Claude 2, then Sol 6.1 once; Sol never expands to Sonnet", () => {
	const routes = withProviderFallbacks([candidate(sonnet)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [sonnet, sonnet2, codexSol]);
	assert.deepEqual(withProviderFallbacks(routes), routes);
	assert.deepEqual(withProviderFallbacks([candidate(codexSol)]).map(c => c.modelSpec), [codexSol]);
});

test("Sonnet ahead of other families keeps Sol as the single last fallback", () => {
	const routes = withProviderFallbacks([candidate(sonnet), candidate(opus)]);
	assert.deepEqual(routes.map(c => c.modelSpec), [sonnet, sonnet2, opus, opus2, astra, codexSol]);
});

test("mixed top-tier and Neuralwatt get appropriate fallbacks", () => {
	const routes = withProviderFallbacks([candidate(opus), candidate(neuralwatt)]);
	// Opus → Claude 2 → Astra, Neuralwatt, then 6.1 Sol
	assert.deepEqual(routes.map(c => c.modelSpec), [opus, opus2, astra, neuralwatt, codexSol]);
});

/** Mock the SDK so `failing` models error with a non-retryable credit failure. */
function mockModels(t: { mock: typeof test.mock }, failing: string[], calls: string[]): ModelRegistry {
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>) => {
		const selected = `${model.provider}/${model.id}`;
		calls.push(selected);
		const failed = failing.includes(selected);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text: "REVIEWED" }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? "402 insufficient\ncredits" : undefined,
			timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		if (failed) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	return {
		find: (provider: string, id: string) => ({
			provider, id, api: "openai-completions", name: id, reasoning: true, input: ["text"],
			contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
		getRegisteredNativeProvider: () => undefined,
		getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
}

for (const [pinned, peer] of [[astra, opus], [opus, astra]]) {
	test(`${pinned} failover skips excluded peer and reports the failed attempt`, { timeout: 10000 }, async (t) => {
		const calls: string[] = [];
		const registry = mockModels(t, [pinned, opus2], calls);
		// Neither the Aperture prefix nor the second Claude account lets the peer slip through.
		const result = await runWorker(agent, "test", {
			registry, fallbackModel: undefined, modelSpec: pinned, excludeModels: [`aperture/${peer}`],
		});
		const failed = pinned === opus ? [opus, opus2] : [astra];
		assert.deepEqual(calls, [...failed, codexSol]);
		assert.equal(result.status, "ok");
		assert.equal(result.model, codexSol);
		assert.deepEqual(result.failedAttempts, failed.map(model => `${model}: 402 insufficient\ncredits`));
	});
}

test("parallel credit fallbacks use Sol only once, then continue with fewer workers", async (t) => {
	const calls: string[] = [];
	const registry = mockModels(t, [opus, opus2, astra, neuralwatt], calls);
	const diversity = new ModelDiversity();
	const results = await Promise.all([opus, astra, neuralwatt].map(modelSpec => runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec, claimModel: diversity.worker(),
	})));
	assert.equal(results.filter(r => r.status === "ok").length, 1);
	assert.equal(calls.filter(model => model === codexSol).length, 1);
	assert.equal(calls.filter(model => model === opus).length, 1);
	assert.equal(calls.filter(model => model === opus2).length, 1, "same owner can retry the other Claude account");
	assert.equal(calls.filter(model => model === astra).length, 1);
	assert.equal(calls.filter(model => model === neuralwatt).length, 1);
	assert.equal(results.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0), calls.length * 2);
	assert.ok(results.filter(r => r.status !== "ok").every(r => r.failedAttempts?.length));
});

test("gateway aliases cannot supply a second voice, but a new phase can reuse models", async (t) => {
	const direct = "neuralwatt/kimi-k3";
	const calls: string[] = [];
	const registry = mockModels(t, [], calls);
	const diversity = new ModelDiversity();
	const first = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: neuralwatt, claimModel: diversity.worker(),
	});
	const warnings: string[] = [];
	const second = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: direct,
		claimModel: diversity.worker(), onWarning: warning => warnings.push(warning),
	});
	assert.equal(first.model, neuralwatt);
	assert.equal(second.model, codexSol);
	assert.deepEqual(calls, [neuralwatt, codexSol]);
	assert.equal(warnings.filter(w => w.includes("already used")).length, 1);
	const council = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: direct, claimModel: new ModelDiversity().worker(),
	});
	assert.equal(council.model, direct);
});

test("excluding every candidate fails without calling a model", async (t) => {
	const calls: string[] = [];
	const registry = mockModels(t, [], calls);
	const result = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: astra, excludeModels: [astra, opus, codexSol],
	});
	assert.deepEqual(calls, []);
	assert.equal(result.status, "error");
	assert.match(result.error!, /excluded/);
});

const glmNeuralwatt = "aperture/neuralwatt/glm-5.3";
const lastResorts = [glmNeuralwatt];

test("workflow last resorts run GLM on Neuralwatt with Sol excluded", async (t) => {
	const calls: string[] = [];
	const registry = mockModels(t, [opus, opus2], calls);
	const result = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: opus, excludeModels: [astra, codexSol], fallbackModels: lastResorts,
	});
	assert.deepEqual(calls, [opus, opus2, glmNeuralwatt]);
	assert.equal(result.status, "ok");
	assert.equal(result.model, glmNeuralwatt);
});

test("workflow last resorts are not retried when already in the chain", async (t) => {
	const calls: string[] = [];
	const registry = mockModels(t, [glmNeuralwatt, codexSol], calls);
	await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: glmNeuralwatt, fallbackModels: lastResorts,
	});
	assert.deepEqual(calls, [glmNeuralwatt, codexSol]);
});

test("parallel reviewers cannot both fall back to GLM", async (t) => {
	const calls: string[] = [];
	const registry = mockModels(t, [opus, opus2, astra, codexSol], calls);
	const pool = new ModelDiversity();
	const [first, second] = await Promise.all([[opus, astra], [astra, opus]].map(([modelSpec, peer]) => runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec, excludeModels: [peer],
		fallbackModels: lastResorts, claimModel: pool.worker(),
	})));
	assert.deepEqual([first.status, second.status].sort(), ["error", "ok"]);
	assert.equal(calls.filter(model => model === glmNeuralwatt).length, 1);
});
