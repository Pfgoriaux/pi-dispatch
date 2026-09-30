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
const keys = ["PI_CODING_AGENT_DIR", "PI_DISPATCH_PI_BIN", "HERDR_ENV", "LINKUP_API_KEY", "DISPATCH_PROFILE_LONG_MODEL"];
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
delete process.env.DISPATCH_PROFILE_LONG_MODEL;
const { default: extension } = await import("../src/index.ts");
const cache = path.join(root, "cache", "usage-bar");
fs.mkdirSync(cache, { recursive: true });
const quotas = (synthetic: number, neuralwatt: number) => {
	for (const [provider, remaining] of [["synthetic", synthetic], ["neuralwatt", neuralwatt]]) {
		fs.writeFileSync(path.join(cache, `${provider}-v3.json`), JSON.stringify({ updatedAt: Date.now(), limits: [{ label: "week", remaining, unit: "%" }] }));
	}
};
const nw = "aperture/neuralwatt/kimi-k3";
const sy = "aperture/synthetic/hf:moonshotai/Kimi-K3";
const agent: AgentConfig = { name: "quota-worker", description: "test", tools: [], model: nw, quotaRouting: true, thinking: "high", systemPrompt: "fixture", source: "bundled", filePath: "fixture" };
const registry = { find: (provider: string, id: string) => ({ provider, id }) } as ModelRegistry;

for (const source of ["tier-frontmatter", "tier-task", "pinned-task", "pinned-frontmatter", "inherit"] as const) {
	test(`SDK quota routing: ${source}`, async () => {
		quotas(100, 30);
		const controller = new AbortController();
		const calls: string[] = [], warnings: string[] = [];
		const result = await runWorker({ ...agent, quotaRouting: source !== "pinned-frontmatter" }, "test", {
			registry, fallbackModel: { provider: "aperture", id: "neuralwatt/kimi-k3" } as any,
			modelSpec: source === "inherit" ? "inherit" : source.endsWith("task") ? nw : undefined,
			steerByQuota: source === "tier-task" ? true : undefined,
			signal: controller.signal, onWarning: w => warnings.push(w),
			onAttempt: model => { calls.push(model); controller.abort(); },
		});
		const routed = source.startsWith("tier-");
		assert.deepEqual(calls, [routed ? sy : nw]);
		assert.equal(warnings.some(w => w.startsWith("Quota routing:")), routed);
		assert.equal(result.status, "aborted", "stops before any provider runtime or request");
	});
}

test("SDK rereads cache for subsequent spawns and skips unavailable routes", async () => {
	for (const [synthetic, neuralwatt, expected] of [[100, 20, sy], [5, 80, nw]] as const) {
		quotas(synthetic, neuralwatt);
		const controller = new AbortController();
		const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, signal: controller.signal,
			onAttempt: model => { assert.equal(model, expected); controller.abort(); },
		});
		assert.equal(result.model, expected);
	}
	quotas(100, 20);
	const controller = new AbortController();
	const result = await runWorker(agent, "test", {
		registry: { find: (provider: string, id: string) => id.startsWith("synthetic/") ? undefined : { provider, id } } as ModelRegistry,
		fallbackModel: undefined, signal: controller.signal, onAttempt: () => controller.abort(),
	});
	assert.equal(result.model, nw);
});

test("Claude exhaustion cannot route a second worker to an already claimed Astra", async () => {
	const opus = "anthropic/claude-opus-5-5", astra = "openai-codex/gpt-6-astra", sol = "openai-codex/gpt-6.1-sol";
	for (const [provider, remaining] of [["claude", 0], ["codex", 39]] as const) {
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
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
	for (const provider of ["claude", "codex"]) fs.rmSync(path.join(cache, `${provider}-v3.json`));
});

test("child workers route tier choices but preserve concrete pins and direct Codex", async () => {
	quotas(100, 20);
	const bin = path.join(root, "fake-pi");
	fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:model}],stopReason:'stop'}}));
`, { mode: 0o700 });
	process.env.PI_DISPATCH_PI_BIN = bin;
	for (const options of [
		{ expected: sy },
		{ modelOverride: nw, steerByQuota: true, expected: sy },
		{ modelOverride: nw, expected: nw },
		{ modelOverride: "openai-codex/gpt-6-astra", expected: "openai-codex/gpt-6-astra" },
	]) {
		const result = await runWorkerProc(agent, "test", { cwd: root, ...options });
		assert.equal(result.status, "ok");
		assert.equal(result.text, options.expected);
		assert.equal(result.attempts, 1);
	}
});

test("dispatch per-task tier opts into routing; explicit per-task provider does not", async () => {
	quotas(100, 20);
	const tools: any[] = [];
	extension({ on() {}, registerTool: (tool: any) => tools.push(tool) } as any);
	const dispatch = tools.find(t => t.name === "dispatch");
	for (const model of ["long", nw]) {
		const controller = new AbortController();
		let selected: string | undefined;
		await dispatch.execute("test", { tasks: [{ agent: "planner", task: "test", model }], aggregate: false, herdr: false }, controller.signal,
			(update: any) => {
				const row = update.details?.activity?.[0];
				if (row?.model && row.attempts > 0) { selected = row.model; controller.abort(); }
			}, { cwd: root, modelRegistry: registry, isProjectTrusted: () => false });
		assert.equal(selected, model === "long" ? sy : nw);
	}
});
