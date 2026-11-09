import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, DefaultResourceLoader, ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { exhaustedQuotaReason, quotaCandidates } from "../src/quota.ts";
import { runWorker } from "../src/worker.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";

const root = mkdtempSync(join(tmpdir(), "dispatch-eligibility-"));
const keys = ["PI_CODING_AGENT_DIR", "PI_DISPATCH_PI_BIN", "HERDR_ENV", "LINKUP_API_KEY"];
const previous = new Map(keys.map(key => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = root;
process.env.HERDR_ENV = "0";
delete process.env.LINKUP_API_KEY;
after(() => {
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
const cache = join(root, "cache", "usage-bar");
mkdirSync(cache, { recursive: true });
const retiredOpus = "anthropic/claude-opus-5-5";
const opus = "anthropic-2/claude-opus-5-5";
const astra = "openai-codex/gpt-6-astra";
const sol = "openai-codex/gpt-6.1-sol";
const nw = "aperture/neuralwatt/kimi-k3";
const agent: AgentConfig = { name: "eligibility-fixture", description: "test", model: opus, tools: [], thinking: "high", systemPrompt: "fixture", source: "bundled", filePath: "fixture" };
const catalog = [retiredOpus, opus, astra, sol, nw].map(spec => {
	const slash = spec.indexOf("/");
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1), reasoning: true };
});
const registry = {
	find: (provider: string, id: string) => catalog.find(model => model.provider === provider && model.id === id),
	getAll: () => catalog, getAvailable: () => catalog,
} as ModelRegistry;
const snapshot = (remaining: number, updatedAt = Date.now()) => ({ updatedAt, limits: [{ label: "week", remaining, unit: "%" as const }] });
function quota(provider: string, remaining: number, updatedAt = Date.now()) {
	writeFileSync(join(cache, `${provider}-v4.json`), JSON.stringify(snapshot(remaining, updatedAt)));
}

for (const source of ["frontmatter", "pin", "inherit", "bare-pin"] as const) {
	test(`SDK rejects exhausted Claude for ${source} without routing`, async () => {
		quota("claude2", 0);
		quota("codex", 40);
		const controller = new AbortController();
		const calls: string[] = [];
		const result = await runWorker(agent, "test", {
			registry,
			fallbackModel: { provider: "anthropic-2", id: "claude-opus-5-5", reasoning: true } as any,
			modelSpec: source === "inherit" ? "inherit" : source === "pin" ? opus : source === "bare-pin" ? "claude-opus-5-5" : undefined,
			steerByQuota: false, signal: controller.signal,
			onAttempt: model => { calls.push(model); controller.abort(); },
		});
		// Claude 2 is skipped; a bare ID resolves like a pin.
		assert.deepEqual(calls, [astra]);
		assert.equal(result.attempts, 1);
		assert.equal(result.status, "aborted");
	});
}

test("exhausted peers and terminal fallback make zero SDK attempts", async () => {
	quota("neuralwatt", 0);
	quota("codex", 0);
	const claimed: string[] = [];
	const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, modelSpec: nw, steerByQuota: true,
		claimModel: model => { claimed.push(model); return true; },
	});
	assert.deepEqual(claimed, []);
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
	assert.match(result.error!, /quota exhausted/);
});

test("retired cache is ignored, and per-model windows bind only their model", () => {
	quota("claude", 0);
	quota("claude2", 50);
	assert.equal(exhaustedQuotaReason(retiredOpus), undefined);
	assert.equal(exhaustedQuotaReason(opus), undefined);
	quota("claude2", 0);
	assert.match(exhaustedQuotaReason(opus)!, /\(week at 0%\)$/);
	const scoped = (label: string) => writeFileSync(join(cache, "claude2-v4.json"), JSON.stringify({ updatedAt: Date.now(), limits: [
		{ label: "5h", remaining: 100, unit: "%" }, { label: "week", remaining: 32, unit: "%" }, { label, remaining: 0, unit: "%" },
	] }));
	scoped("fableweek");
	assert.equal(exhaustedQuotaReason(opus), undefined);
	assert.match(exhaustedQuotaReason("anthropic-2/claude-fable-5-1")!, /claude2 quota exhausted \(fableweek at 0%\)/);
	for (const label of ["opus55week", "opusweek"]) {
		scoped(label);
		assert.match(exhaustedQuotaReason(opus)!, /claude2 quota exhausted/);
		assert.equal(exhaustedQuotaReason("anthropic-2/claude-sonnet-5-5"), undefined);
	}
	rmSync(join(cache, "claude2-v4.json"));
});

test("eligibility rereads caches and only blocks fresh, known exhaustion", () => {
	quota("claude2", 0);
	assert.match(exhaustedQuotaReason(opus)!, /claude2 quota exhausted/);
	quota("claude2", 30);
	assert.equal(exhaustedQuotaReason(opus), undefined);
	quota("claude2", 0, Date.now() - 180_001);
	assert.equal(exhaustedQuotaReason(opus), undefined);
	rmSync(join(cache, "claude2-v4.json"));
	assert.equal(exhaustedQuotaReason(opus), undefined);
	quota("neuralwatt", 0);
	assert.match(exhaustedQuotaReason("neuralwatt/glm-5.3")!, /neuralwatt quota exhausted/);
	assert.match(exhaustedQuotaReason("aperture/neuralwatt/glm-5.3")!, /neuralwatt quota exhausted/);
});

test("Neuralwatt overage budget keeps workers eligible after the included energy", () => {
	const overage = (extra: number) => writeFileSync(join(cache, "neuralwatt-v4.json"), JSON.stringify({ updatedAt: Date.now(), limits: [
		{ label: "extra", remaining: 2 * extra, unit: "$", percentRemaining: extra, at: Date.now() + 86_400_000, renewal: "reset" },
		{ label: "credits", remaining: 51.26, unit: "$", percentRemaining: 93 },
	] }));
	overage(25);
	assert.equal(exhaustedQuotaReason("aperture/neuralwatt/glm-5.3"), undefined);
	overage(0);
	assert.match(exhaustedQuotaReason("aperture/neuralwatt/glm-5.3")!, /neuralwatt quota exhausted \(extra at 0%\)/);
});

test("low quotas never inject a model outside the configured candidates", () => {
 for (const provider of ["claude2","codex","neuralwatt"]) quota(provider, 5);
 const candidates = [{ modelSpec: "fake/small", thinking: "off", entry: { provider: "fake", model: "small", thinking: "off", weight: 1 } }];
 assert.deepEqual(quotaCandidates(candidates), candidates);
});

const bin = join(root, "fake-pi");
writeFileSync(bin, `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf('--model') + 1];
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:model}],stopReason:'stop'}}));
`, { mode: 0o700 });
process.env.PI_DISPATCH_PI_BIN = bin;

for (const source of ["frontmatter", "pin", "inherit"] as const) {
	test(`child rejects exhausted Claude for ${source} without routing`, async () => {
		quota("claude2", 0);
		quota("codex", 40);
		const result = await runWorkerProc(agent, "test", { cwd: root, model: opus,
			modelOverride: source === "inherit" ? "inherit" : source === "pin" ? opus : undefined,
			steerByQuota: false,
		});
		assert.equal(result.status, "ok");
		assert.equal(result.text, astra);
		assert.equal(result.attempts, 1);
	});
}

test("child remaps a retired first-account pin to Claude 2", async () => {
	quota("claude", 0);
	quota("claude2", 30);
	quota("codex", 90);
	const calls: string[] = [];
	const result = await runWorkerProc(agent, "test", { cwd: root, registry, modelOverride: retiredOpus, steerByQuota: false,
		onAttempt: model => calls.push(model),
	});
	assert.deepEqual(calls, [opus]);
	assert.equal(result.status, "ok");
	assert.equal(result.model, opus);
});

test("registry-free children remap first-account pins regardless of provider case", async () => {
	quota("claude2", 50);
	for (const provider of ["anthropic", "Anthropic", "ANTHROPIC"]) {
		const calls: string[] = [];
		const result = await runWorkerProc(agent, "test", {
			cwd: root, modelOverride: `${provider}/claude-opus-5-5`, steerByQuota: false,
			onAttempt: model => calls.push(model),
		});
		assert.equal(result.status, "ok");
		assert.deepEqual(calls, [opus]);
		assert.equal(result.text, opus);
	}
});

test("a bare Claude ID ignores the retired account in both tiers", async () => {
	const both = { ...registry, getAll: () => catalog } as ModelRegistry;
	quota("claude2", 50);
	const controller = new AbortController();
	const sdkCalls: string[] = [];
	await runWorker(agent, "test", { registry: both, fallbackModel: undefined, modelSpec: "claude-opus-5-5", steerByQuota: false,
		signal: controller.signal, onAttempt: model => { sdkCalls.push(model); controller.abort(); },
	});
	assert.deepEqual(sdkCalls, [opus]);
	const child = await runWorkerProc(agent, "test", { cwd: root, registry: both, modelOverride: "claude-opus-5-5", steerByQuota: false });
	assert.equal(child.status, "ok");
	assert.equal(child.model, opus);
});

test("child resolves bare IDs before quota checks and pins the actual provider", async () => {
	const bareRegistry = { ...registry, getAll: () => [{ provider: "anthropic-2", id: "claude-opus-5-5", reasoning: true }] } as any;
	quota("claude2", 0);
	quota("codex", 40);
	const result = await runWorkerProc(agent, "test", { cwd: root, modelOverride: "claude-opus-5-5", registry: bareRegistry });
	assert.equal(result.status, "ok");
	assert.equal(result.text, astra);
	assert.equal(result.attempts, 1);
});

test("child rejects unknown models and slash-containing bare IDs", async () => {
	quota("claude2", 0);
	const slashRegistry = { ...registry, getAll: () => [{ provider: "anthropic-2", id: "custom/opus" }] } as any;
	for (const modelOverride of ["custom/opus", "anthropic/unknown-model"]) {
		const calls: string[] = [];
		const result = await runWorkerProc(agent, "test", { cwd: root, modelOverride, registry: slashRegistry,
			onAttempt: model => calls.push(model),
		});
		assert.equal(result.status, "error");
		assert.equal(result.attempts, 0);
		assert.deepEqual(calls, []);
	}
	assert.match(exhaustedQuotaReason("Anthropic/claude-opus-5-5")!, /claude2 quota exhausted/);
});

test("child cancellation wins over unresolved and unspecified identities", async () => {
	for (const model of [undefined, "unknown"]) {
		const result = await runWorkerProc({ ...agent, model }, "test", { cwd: root, signal: AbortSignal.abort() });
		assert.equal(result.status, "aborted");
		assert.equal(result.attempts, 0);
	}
});

test("child validates generated fallbacks against the parent registry", async () => {
	quota("claude2", 0);
	quota("codex", 40);
	const onlyOpus = { ...registry, find: (provider: string, id: string) => provider === "anthropic-2" ? registry.find(provider, id) : undefined } as ModelRegistry;
	const calls: string[] = [];
	const result = await runWorkerProc(agent, "test", { cwd: root, registry: onlyOpus, onAttempt: model => calls.push(model) });
	assert.deepEqual(calls, []);
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
});

test("child refuses unknown provider identity instead of using CLI defaults", async () => {
	for (const config of [{ ...agent, model: undefined }, { ...agent, model: "claude-opus-5-5" }]) {
		const calls: string[] = [];
		const result = await runWorkerProc(config, "test", { cwd: root, onAttempt: model => calls.push(model) });
		assert.deepEqual(calls, []);
		assert.equal(result.status, "error");
		assert.equal(result.attempts, 0);
		assert.match(result.error!, /resolved provider\/model identity/);
	}
});

test("child skips all exhausted routes without spawning or inheriting", async () => {
	quota("neuralwatt", 0);
	quota("codex", 0);
	const calls: string[] = [];
	const result = await runWorkerProc(agent, "test", { cwd: root, modelOverride: nw, steerByQuota: true,
		onAttempt: model => calls.push(model),
	});
	assert.deepEqual(calls, []);
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
	assert.match(result.error!, /quota exhausted/);
});

test("child fallback checks updated Codex quota before its next attempt", async t => {
	t.after(() => rmSync(join(cache, "claude2-v4.json"), { force: true }));
	quota("claude2", 50);
	quota("codex", 50);
	writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const model = process.argv[process.argv.indexOf('--model') + 1];
if (model.includes('claude-opus-5-5')) {
  fs.writeFileSync(${JSON.stringify(join(cache, "codex-v4.json"))}, JSON.stringify({updatedAt:Date.now(),limits:[{label:'week',remaining:0,unit:'%'}]}));
  process.exit(1);
}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:model}],stopReason:'stop'}}));
`, { mode: 0o700 });
	const calls: string[] = [];
	const result = await runWorkerProc(agent, "test", { cwd: root, registry, modelOverride: opus, steerByQuota: false, onAttempt: model => calls.push(model) });
	assert.equal(result.status, "error");
	assert.deepEqual(calls, [opus], "must skip exhausted Astra and Sol");
	assert.equal(result.attempts, 1);
});

test("SDK rechecks quotas after asynchronous setup without counting a skipped prompt", async t => {
	quota("neuralwatt", 50);
	quota("codex", 50);
	const reload = DefaultResourceLoader.prototype.reload;
	t.mock.method(DefaultResourceLoader.prototype, "reload", async function (this: DefaultResourceLoader) {
		await reload.call(this);
		quota("neuralwatt", 0);
	});
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	const prompts: string[] = [];
	t.mock.method(AgentSession.prototype, "prompt", async function (this: AgentSession) {
		prompts.push(`${this.model!.provider}/${this.model!.id}`);
	});
	t.mock.method(AgentSession.prototype, "getLastAssistantText", () => "fixture response");
	const setupRegistry = {
		...registry,
		find: (provider: string, id: string) => ({ provider, id, api: "openai-completions", name: id, reasoning: true,
			input: ["text"], contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		getRegisteredNativeProvider: () => undefined, getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
	const result = await runWorker(agent, "test", { registry: setupRegistry, fallbackModel: undefined, modelSpec: nw });
	assert.deepEqual(prompts, [sol]);
	assert.equal(result.status, "ok");
	assert.equal(result.attempts, 1);
	assert.equal(result.failedAttempts, undefined);
});

test("unregistered fallbacks preserve the last child provider error", async () => {
	quota("claude2", 50);
	quota("codex", 50);
	writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'fixture provider error'}}));
process.exitCode = 1;
`, { mode: 0o700 });
	const onlyOpus = { ...registry, find: (provider: string, id: string) => provider === "anthropic-2" ? registry.find(provider, id) : undefined } as ModelRegistry;
	const result = await runWorkerProc(agent, "test", { cwd: root, registry: onlyOpus });
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 1);
	assert.equal(result.model, opus);
	assert.match(result.error!, /fixture provider error/);
});

test("cancellation from the final quota-skip warning wins in both tiers", async () => {
	quota("codex", 0);
	for (const tier of ["sdk", "child"]) {
		const controller = new AbortController();
		const options = { signal: controller.signal, onWarning: () => controller.abort() };
		const result = tier === "sdk"
			? await runWorker(agent, "test", { ...options, registry, fallbackModel: undefined, modelSpec: sol })
			: await runWorkerProc(agent, "test", { ...options, cwd: root, modelOverride: sol });
		assert.equal(result.status, "aborted");
		assert.equal(result.attempts, 0);
	}
});

test("child flags preserve provider-prefixed IDs through the installed CLI resolver", async () => {
	const models = [{ provider: "p", id: "p/foo", reasoning: true }, { provider: "p", id: "z/foo", reasoning: true }];
	const prefixedRegistry = { find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id) } as ModelRegistry;
	writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(process.argv.slice(2))}],stopReason:'stop'}}));
`, { mode: 0o700 });
	const result = await runWorkerProc(agent, "test", { cwd: root, modelOverride: "p/p/foo", registry: prefixedRegistry });
	assert.equal(result.status, "ok");
	const args = JSON.parse(result.text) as string[];
	const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { resolveCliModel } = await import(new URL("./core/model-resolver.js", sdk).href);
	const resolved = resolveCliModel({ cliProvider: args[args.indexOf("--provider") + 1], cliModel: args[args.indexOf("--model") + 1],
		modelRuntime: { getModels: () => models },
	});
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.model.id, "p/foo");
	models.push({ provider: "p", id: "foo", reasoning: true });
	const colliding = await runWorkerProc(agent, "test", { cwd: root, modelOverride: "p/p/foo", registry: prefixedRegistry });
	assert.equal(colliding.status, "error");
	assert.equal(colliding.attempts, 0);
});
