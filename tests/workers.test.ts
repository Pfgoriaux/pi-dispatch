import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runWorker, truncateText } from "../src/worker.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import { rankCandidates, markCooldown, withProviderFallbacks, type RankedCandidate } from "../src/roster.ts";
import { shellQuote } from "../src/panes.ts";
import type { AgentConfig } from "../src/types.ts";

const agent: AgentConfig = {
	name: "scout",
	description: "test",
	tools: ["read"],
	model: "configured/other",
	thinking: "low",
	systemPrompt: "test",
	source: "bundled",
	filePath: "test",
};
const model = { provider: "fake", id: "model" } as Model<Api>;
const registry = { find: () => model } as unknown as ModelRegistry;

test("explicit inherit bypasses roster and selects parent without a live request", async () => {
	const controller = new AbortController();
	const events: string[] = [];
	const result = await runWorker(agent, "test", {
		registry,
		fallbackModel: model,
		modelSpec: "inherit",
		signal: controller.signal,
		onAttempt: (selected) => {
			events.push(selected);
			controller.abort();
		},
	});
	assert.deepEqual(events, ["fake/model"]);
	assert.equal(result.status, "aborted");
});

test("explicit model retains agent effort and reports resolved identity", async () => {
	const controller = new AbortController();
	await runWorker(agent, "test", {
		registry,
		fallbackModel: model,
		modelSpec: "fake/model",
		signal: controller.signal,
		onAttempt: (selected, thinking, attempt) => {
			assert.equal(selected, "fake/model");
			assert.equal(thinking, "low");
			assert.equal(attempt, 1);
			controller.abort();
		},
	});
});

test("UTF-8 truncation preserves complete code points", () => {
	for (const input of ["é".repeat(20), "😀".repeat(20), "a界😀".repeat(20)]) {
		for (let cap = 1; cap < 20; cap++) {
			const out = truncateText(input, cap);
			assert.equal(out.truncated, true);
			const prefix = out.text.split("\n\n[output truncated:")[0];
			assert.ok(Buffer.byteLength(prefix) <= cap);
			assert.ok(!prefix.includes("�"));
		}
	}
});

test("ranked roster retains provider/model names containing slashes", () => {
	const ranked = rankCandidates([
		{ provider: "a", model: "family/m1", thinking: "off", weight: 1 },
		{ provider: "b", model: "m2", thinking: "low", weight: 3 },
	]);
	assert.deepEqual(
		ranked.map((r) => r.modelSpec),
		["b/m2", "a/family/m1"],
	);
});

test("Neuralwatt routes retry the same model via Aperture Synthetic before changing families", () => {
	const entries = [
		{ provider: "aperture", model: "neuralwatt/kimi-k3", thinking: "low", weight: 3 },
		{ provider: "neuralwatt", model: "glm-5.3-flash", thinking: "high", weight: 2 },
		{ provider: "aperture", model: "synthetic/hf:moonshotai/Kimi-K3", thinking: "low", weight: 1 },
	];
	const ranked = rankCandidates(entries);
	assert.deepEqual(ranked.map(c => c.modelSpec), [
		"aperture/neuralwatt/kimi-k3", "aperture/synthetic/hf:moonshotai/Kimi-K3",
		"neuralwatt/glm-5.3-flash", "aperture/synthetic/hf:zai-org/GLM-5.3-Flash",
		"openai-codex/gpt-5.6-terra",
	]);
	assert.equal(ranked[1].thinking, "low");
	assert.equal(ranked[1].entry.provider, "aperture");
	assert.equal(ranked[1].entry.model, "synthetic/hf:moonshotai/Kimi-K3");
	assert.deepEqual(withProviderFallbacks(ranked), ranked, "expansion is idempotent");
	markCooldown("aperture", "neuralwatt/kimi-k3");
	assert.equal(rankCandidates(entries)[0].modelSpec, "aperture/synthetic/hf:moonshotai/Kimi-K3");
	markCooldown("aperture", "synthetic/hf:moonshotai/Kimi-K3");
	assert.equal(rankCandidates(entries)[0].modelSpec, "neuralwatt/glm-5.3-flash");
});

test("non-flash GLM 5.3 on Neuralwatt falls back to Synthetic's Flash variant", () => {
	const candidates: RankedCandidate[] = [{
		modelSpec: "aperture/neuralwatt/glm-5.3",
		thinking: "high",
		entry: { provider: "aperture", model: "neuralwatt/glm-5.3", thinking: "high", weight: 1 },
	}];
	assert.deepEqual(withProviderFallbacks(candidates).map((c) => c.modelSpec), [
		"aperture/neuralwatt/glm-5.3",
		"aperture/synthetic/hf:zai-org/GLM-5.3-Flash",
		"openai-codex/gpt-5.6-terra",
	]);
});

test("unmapped models and other providers do not invent Synthetic routes", () => {
	for (const modelSpec of ["neuralwatt/unknown", "neuralwatt/glm-5.2", "neuralwatt/deepseek-v4.1-flash", "other/kimi-k3", "aperture/neuralwatt/kimi-k3-fast"]) {
		const candidates = [{ modelSpec, thinking: "low", entry: { provider: "test", model: modelSpec, thinking: "low", weight: 1 } }];
		assert.deepEqual(withProviderFallbacks(candidates), candidates);
	}
});

for (const source of ["explicit", "inherit", "frontmatter"] as const) {
	test(`${source} Aperture failure tries Synthetic through Aperture; abort stops further work`, async (t) => {
		t.mock.method(ModelRuntime, "create", async () => { throw new Error("402 payment_required"); });
		const controller = new AbortController();
		const attempts: string[] = [];
		const parent = { provider: "aperture", id: "neuralwatt/kimi-k3" } as Model<Api>;
		const result = await runWorker({ ...agent, name: "fallback-test-agent", model: "aperture/neuralwatt/kimi-k3" }, "test", {
			registry: { find: (provider: string, id: string) => ({ provider, id }) } as ModelRegistry,
			fallbackModel: parent,
			modelSpec: source === "explicit" ? "aperture/neuralwatt/kimi-k3" : source === "inherit" ? "inherit" : undefined,
			signal: controller.signal,
			onAttempt: (selected, _thinking, attempt) => {
				attempts.push(selected);
				assert.equal(attempt, attempts.length);
				if (attempt === 2) controller.abort();
			},
		});
		assert.deepEqual(attempts, ["aperture/neuralwatt/kimi-k3", "aperture/synthetic/hf:moonshotai/Kimi-K3"]);
		assert.equal(result.status, "aborted");
		assert.equal(result.model, "aperture/synthetic/hf:moonshotai/Kimi-K3");
	});
}

test("exhaustion preserves billing error and actual model when fallback cannot resolve", async (t) => {
	t.mock.method(ModelRuntime, "create", async () => { throw new Error("402 payment_required"); });
	const result = await runWorker(agent, "test", {
		registry: { find: (provider: string, id: string) => provider === "aperture" && id === "neuralwatt/kimi-k3" ? { provider, id } : undefined } as ModelRegistry,
		fallbackModel: undefined,
		modelSpec: "aperture/neuralwatt/kimi-k3",
	});
	assert.equal(result.status, "error");
	assert.match(result.error!, /402 payment_required/);
	assert.equal(result.model, "aperture/neuralwatt/kimi-k3");
	assert.equal(result.attempts, 1);
});

test("viewer log paths are shell quoted", () => {
	assert.equal(
		shellQuote("/tmp/path with 'quote"),
		"'/tmp/path with '\\''quote'",
	);
});

test("child args prevent recursive workflows, forward thinking, and inherit parent", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-child-test-"));
	const bin = path.join(dir, "fake-pi");
	const previous = process.env.PI_DISPATCH_PI_BIN;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_DISPATCH_PI_BIN;
		else process.env.PI_DISPATCH_PI_BIN = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const content = [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }];
console.log(JSON.stringify({type: "tool_execution_end", toolName: "read", isError: true, result: {secret: "hidden"}}));
console.log(JSON.stringify({type: "tool_execution_end", toolName: "read private/path</arg_value>", isError: true}));
console.log(JSON.stringify({type: "message_end", message: {role: "assistant", content, model: "fake-model", stopReason: "stop"}}));
`,
		{ mode: 0o700 },
	);
	process.env.PI_DISPATCH_PI_BIN = bin;
	const logs: string[] = [];
	const result = await runWorkerProc(agent, "--not-a-flag", {
		onStream: (line) => logs.push(line),
		cwd: dir,
		model: "parent/model",
		modelOverride: "inherit",
		thinking: "high",
	});
	assert.equal(result.status, "ok");
	assert.ok(logs.includes("tool_execution_end: read [error]"));
	assert.ok(logs.includes("tool_execution_end: [unregistered tool] [error]"));
	assert.ok(!logs.join("\n").includes("private"));
	assert.ok(!logs.join("\n").includes("hidden"));
	const args = JSON.parse(result.text) as string[];
	assert.equal(
		args[args.indexOf("--exclude-tools") + 1],
		"dispatch,pr_review,feature_plan",
	);
	assert.equal(args[args.indexOf("--model") + 1], "parent/model");
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
	assert.deepEqual(args.slice(-2), ["--", "--not-a-flag"]);
	fs.writeFileSync(bin, "#!/usr/bin/env node\n", { mode: 0o700 });
	assert.equal(
		(await runWorkerProc(agent, "test", { cwd: dir })).status,
		"error",
		"zero exit with blank output must fail",
	);
});
