import assert from "node:assert/strict";
import test, { after } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runWorker } from "../src/worker.ts";
import { ModelDiversity } from "../src/model-diversity.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-quota-workers-"));
const keys = ["PI_CODING_AGENT_DIR", "PI_DISPATCH_PI_BIN", "HERDR_ENV", "LINKUP_API_KEY", "DISPATCH_PROFILE_PRECISE_MODEL"];
const previous = new Map(keys.map(key => [key, process.env[key]]));
after(() => {
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});
process.env.PI_CODING_AGENT_DIR = root;
process.env.HERDR_ENV = "0";
delete process.env.LINKUP_API_KEY;
delete process.env.DISPATCH_PROFILE_PRECISE_MODEL;
const { default: extension } = await import("../src/index.ts");
const cache = path.join(root, "cache", "usage-bar");
fs.mkdirSync(cache, { recursive: true });
const quotas = (claude: number, codex: number) => {
	for (const [provider, remaining] of [["claude", claude], ["codex", codex]]) {
		fs.writeFileSync(path.join(cache, `${provider}-v3.json`), JSON.stringify({ updatedAt: Date.now(), limits: [{ label: "week", remaining, unit: "%" }] }));
	}
};
const opus = "anthropic/claude-opus-5-5";
const astra = "openai-codex/gpt-6-astra";
const agent: AgentConfig = { name: "quota-worker", description: "test", tools: [], model: opus, quotaRouting: true, thinking: "high", systemPrompt: "fixture", source: "bundled", filePath: "fixture" };
const registry = { find: (provider: string, id: string) => ({ provider, id, reasoning: true }) } as ModelRegistry;

for (const source of ["tier-frontmatter", "tier-task", "pinned-task", "pinned-frontmatter", "inherit"] as const) {
	test(`SDK quota routing: ${source}`, async () => {
		quotas(30, 100);
		const controller = new AbortController();
		const calls: string[] = [], warnings: string[] = [];
		const result = await runWorker({ ...agent, quotaRouting: source !== "pinned-frontmatter" }, "test", {
			registry, fallbackModel: { provider: "anthropic", id: "claude-opus-5-5", reasoning: true } as any,
			modelSpec: source === "inherit" ? "inherit" : source.endsWith("task") ? opus : undefined,
			steerByQuota: source === "tier-task" ? true : undefined,
			signal: controller.signal, onWarning: w => warnings.push(w),
			onAttempt: model => { calls.push(model); controller.abort(); },
		});
		const routed = source.startsWith("tier-");
		assert.deepEqual(calls, [routed ? astra : opus]);
		assert.equal(warnings.some(w => w.startsWith("Quota routing:")), routed);
		assert.equal(result.status, "aborted", "stops before any provider runtime or request");
	});
}

test("SDK rereads cache for subsequent spawns and skips unavailable routes", async () => {
	for (const [claude, codex, expected] of [[20, 100, astra], [80, 5, opus]] as const) {
		quotas(claude, codex);
		const controller = new AbortController();
		const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, signal: controller.signal,
			onAttempt: model => { assert.equal(model, expected); controller.abort(); },
		});
		assert.equal(result.model, expected);
	}
	quotas(20, 100);
	const controller = new AbortController();
	const result = await runWorker(agent, "test", {
		registry: { find: (provider: string, id: string) => id === "gpt-6-astra" ? undefined : { provider, id, reasoning: true } } as ModelRegistry,
		fallbackModel: undefined, signal: controller.signal, onAttempt: () => controller.abort(),
	});
	// Astra took Opus's slot; Claude 2 keeps its own.
	assert.equal(result.model, "anthropic-2/claude-opus-5-5");
});

const writeQuotas = (entries: readonly (readonly [string, number])[]) => {
	for (const [provider, remaining] of entries) {
		fs.writeFileSync(path.join(cache, `${provider}-v3.json`), JSON.stringify({ updatedAt: Date.now(), limits: [{ label: "week", remaining, unit: "%" }] }));
	}
};

test("exhausted Claude reaches Claude 2 with steering off; steering may prefer Astra", async () => {
	const opus = "anthropic/claude-opus-5-5", opus2 = "anthropic-2/claude-opus-5-5";
	writeQuotas([["claude", 0], ["claude2", 30], ["codex", 90]]);
	const warnings: string[] = [];
	for (const steerByQuota of [false, true]) {
		const controller = new AbortController();
		const calls: string[] = [];
		await runWorker(agent, "test", {
			registry, fallbackModel: undefined, modelSpec: opus, steerByQuota, signal: controller.signal,
			onWarning: w => warnings.push(w), onAttempt: model => { calls.push(model); controller.abort(); },
		});
		// Steering may prefer Astra by headroom; hard eligibility alone must reach Claude 2.
		assert.deepEqual(calls, [steerByQuota ? "openai-codex/gpt-6-astra" : opus2]);
	}
	assert.ok(warnings.some(w => w.includes(`Skipped ${opus}: claude quota exhausted`)));
	for (const provider of ["claude", "claude2", "codex"]) fs.rmSync(path.join(cache, `${provider}-v3.json`));
});

test("Claude exhaustion cannot route a second worker to an already claimed Astra", async () => {
	const opus = "anthropic/claude-opus-5-5", astra = "openai-codex/gpt-6-astra", sol = "openai-codex/gpt-6.1-sol";
	for (const [provider, remaining] of [["claude", 0], ["claude2", 0], ["codex", 39]] as const) {
		fs.writeFileSync(path.join(cache, `${provider}-v3.json`), JSON.stringify({ updatedAt: Date.now(), limits: [{ label: "week", remaining, unit: "%" }] }));
	}
	const diversity = new ModelDiversity();
	assert.equal(diversity.worker()(astra), true);
	assert.equal(diversity.worker()(sol), true);
	const controller = new AbortController();
	const calls: string[] = [], warnings: string[] = [];
	const result = await runWorker(agent, "test", {
		registry, fallbackModel: undefined, modelSpec: opus, steerByQuota: true,
		claimModel: diversity.worker(), signal: controller.signal, onWarning: w => warnings.push(w),
		onAttempt: model => { calls.push(model); controller.abort(); },
	});
	assert.deepEqual(calls, []);
	assert.ok(warnings.some(w => w.startsWith("Quota routing:")));
	assert.ok(warnings.some(w => w.includes(`Skipped ${astra}`)));
	assert.ok(warnings.some(w => w.includes(`Skipped ${opus}: claude quota exhausted`)));
	assert.ok(warnings.some(w => w.includes("Skipped anthropic-2/claude-opus-5-5: claude2 quota exhausted")));
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
	for (const provider of ["claude", "claude2", "codex"]) fs.rmSync(path.join(cache, `${provider}-v3.json`));
});

test("child workers route tier choices but preserve concrete pins", async () => {
	quotas(20, 100);
	const bin = path.join(root, "fake-pi");
	fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:model}],stopReason:'stop'}}));
`, { mode: 0o700 });
	process.env.PI_DISPATCH_PI_BIN = bin;
	for (const options of [
		{ expected: astra },
		{ modelOverride: opus, steerByQuota: true, expected: astra },
		{ modelOverride: opus, expected: opus },
		{ modelOverride: "aperture/neuralwatt/kimi-k3", expected: "aperture/neuralwatt/kimi-k3" },
	]) {
		const result = await runWorkerProc(agent, "test", { cwd: root, ...options });
		assert.equal(result.status, "ok");
		assert.equal(result.text, options.expected);
		assert.equal(result.attempts, 1);
	}
});

test("dispatch per-task tier opts into routing; explicit per-task provider does not", async () => {
	quotas(20, 100);
	const tools: any[] = [];
	extension({ on() {}, registerTool: (tool: any) => tools.push(tool) } as any);
	const dispatch = tools.find(t => t.name === "dispatch");
	for (const model of ["precise", opus]) {
		const controller = new AbortController();
		let selected: string | undefined;
		await dispatch.execute("test", { tasks: [{ agent: "planner", task: "test", model }], aggregate: false, herdr: false }, controller.signal,
			(update: any) => {
				const row = update.details?.activity?.[0];
				if (row?.model && row.attempts > 0) { selected = row.model; controller.abort(); }
			}, { cwd: root, modelRegistry: registry, isProjectTrusted: () => false });
		assert.equal(selected, model === "precise" ? astra : opus);
	}
});

test("child and in-process workers gate GLM on Opus/Astra quota", async () => {
	const glm = "aperture/neuralwatt/glm-5.3";
	process.env.PI_DISPATCH_PI_BIN = path.join(root, "fake-pi");
	for (const [claude, codex, gateGlm, expected] of [
		[80, 20, true, opus], [20, 80, true, astra], [30, 30, true, glm], [80, 80, false, glm],
	] as const) {
		quotas(claude, codex);
		const proc = await runWorkerProc(agent, "test", { cwd: root, modelOverride: glm, gateGlm });
		assert.equal(proc.text, expected);
		const controller = new AbortController();
		const calls: string[] = [];
		await runWorker(agent, "test", {
			registry, fallbackModel: undefined, modelSpec: glm, gateGlm, signal: controller.signal,
			onAttempt: model => { calls.push(model); controller.abort(); },
		});
		assert.deepEqual(calls, [expected]);
	}
});

test("dispatch gates explicit GLM tasks", async () => {
	quotas(80, 20);
	const tools: any[] = [];
	extension({ on() {}, registerTool: (tool: any) => tools.push(tool) } as any);
	const dispatch = tools.find(t => t.name === "dispatch");
	const controller = new AbortController();
	let selected: string | undefined;
	await dispatch.execute("test", { tasks: [{ agent: "planner", task: "test", model: "aperture/neuralwatt/glm-5.3" }], aggregate: false, herdr: false }, controller.signal,
		(update: any) => {
			const row = update.details?.activity?.[0];
			if (row?.model && row.attempts > 0) { selected = row.model; controller.abort(); }
		}, { cwd: root, modelRegistry: registry, isProjectTrusted: () => false });
	assert.equal(selected, opus);
});
