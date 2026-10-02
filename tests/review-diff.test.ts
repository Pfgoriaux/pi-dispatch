import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { resolveDiff, registerPrReviewTool } from "../src/tools/pr-review.ts";
import { registerFeaturePlanTool } from "../src/tools/feature-plan.ts";
import { modelIdentity } from "../src/model-diversity.ts";
import type { WorkerResult } from "../src/types.ts";

function fixture(t: { after: (fn: () => void) => void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-diff-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("rejects Git option injection before executing anything", async (t) => {
	const dir = fixture(t);
	const pi = {
		exec: async () => {
			throw new Error("must not execute");
		},
	} as unknown as ExtensionAPI;
	for (const arg of [
		"--output=/tmp/target..patch",
		"--stat",
		"HEAD\n--output=file",
	]) {
		await assert.rejects(
			resolveDiff(pi, arg, dir, dir),
			/expected a PR number or Git revision/,
		);
	}
});

test("Git failure is not reviewed as an empty diff", async (t) => {
	const dir = fixture(t);
	const pi = {
		exec: async () => ({
			code: 128,
			stdout: "",
			stderr: "bad revision",
			killed: false,
		}),
	} as unknown as ExtensionAPI;
	await assert.rejects(resolveDiff(pi, "bad...HEAD", dir, dir), /bad revision/);
});

test("GitHub diff uses requested cwd, checks failures, never uses undefined Git ref", async (t) => {
	const dir = fixture(t);
	let fail = false;
	const calls: string[][] = [];
	const pi = {
		exec: async (cmd: string, args: string[], options: { cwd?: string }) => {
			calls.push([cmd, ...args]);
			if (cmd === "bash")
				return { code: 0, stdout: "", stderr: "", killed: false };
			assert.equal(cmd, "gh");
			assert.equal(options.cwd, dir);
			return {
				code: fail ? 1 : 0,
				stdout: fail ? "" : "diff --git a/test b/test\n",
				stderr: fail ? "authentication failed" : "",
				killed: false,
			};
		},
	} as unknown as ExtensionAPI;
	const result = await resolveDiff(pi, "123", dir, dir);
	assert.equal(result.empty, false);
	assert.equal(calls.filter(([cmd]) => cmd === "git").length, 0);
	fail = true;
	await assert.rejects(
		resolveDiff(pi, "123", dir, dir),
		/authentication failed/,
	);
});

test("local diffs disable external drivers and mark genuine empty targets", async (t) => {
	const dir = fixture(t);
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			assert.equal(cmd, "git");
			assert.ok(args.includes("--no-ext-diff"));
			assert.ok(args.includes("--no-textconv"));
			assert.equal(args.at(-1), "--");
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	assert.equal((await resolveDiff(pi, "main...HEAD", dir, dir)).empty, true);
});

test("omitted fix reaches read-only diff resolution even in an untrusted dirty repo", async () => {
	let tool: any;
	const pi = {
		registerTool: (value: unknown) => {
			tool = value;
		},
		exec: async () => ({
			code: 128,
			stdout: "",
			stderr: "diff sentinel",
			killed: false,
		}),
	} as unknown as ExtensionAPI;
	registerPrReviewTool(pi);
	await assert.rejects(
		tool.execute(
			"test",
			{ pr: "missing...HEAD", herdr: false },
			undefined,
			undefined,
			{
				cwd: path.resolve(import.meta.dirname, ".."),
				isProjectTrusted: () => false,
			},
		),
		/diff sentinel/,
	);
});

test("workflow credit fallbacks never duplicate models within parallel phases", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
	});
	let tool: any;
	const prompts: string[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		prompts.push(JSON.stringify(context));
		const failed = model.provider !== "openai-codex" || model.id.includes("astra");
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text: "No findings." }],
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
	registerPrReviewTool({
		registerTool: (value: unknown) => { tool = value; },
		exec: async (cmd: string) => ({ code: cmd === "git" ? 0 : 1, stdout: cmd === "git" ? "diff --git a/test b/test\n" : "", stderr: "", killed: false }),
	} as unknown as ExtensionAPI);
	const result = await tool.execute("test", { pr: "main...HEAD", herdr: false }, undefined, undefined, {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	});
	assert.match(result.content[0].text, /# PR review/);
	assert.match(result.content[0].text, /No findings|Fix skipped/);
	const [opus, astra, preMortem, slop] = result.details.items as WorkerResult[];
	assert.equal([opus, astra].filter(r => r.status === "ok").length, 1, "only one code reviewer may take the shared Sol fallback");
	assert.equal(preMortem.status, "ok", "pre-mortem falls back outside the reviewer guard");
	assert.equal(slop.status, "ok", "slop falls back outside the reviewer guard");
	assert.equal(result.details.items.length, 5, "four parallel steps, then one verify-aggregate step");
	assert.equal(result.details.items[4].status, "ok");
	const verifyPrompt = prompts.find(p => p.includes("VERIFY and AGGREGATE")) ?? "";
	for (const label of ["Correctness + security reviewer", "Correctness reviewer", "Pre-mortem", "Slop reviewer"])
		assert.ok(verifyPrompt.includes(`### ${label} [actual model:`), `verify step receives ${label}`);

});

test("feature_plan passes each step forward and keeps architect and challenger apart", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
	});
	const steps = [["Finalize your design", "FINAL-TEXT"], ["Challenge this feature design", "CHALLENGE-TEXT"],
		["Run a pre-mortem", "PREMORTEM-TEXT"], ["You are the architect for this feature", "DRAFT-TEXT"]];
	let fail = (_provider: string, _step: string) => false;
	let onStep = (_step: string) => {};
	const calls: { provider: string; step: string; prompt: string }[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		const prompt = JSON.stringify(context);
		const step = steps.find(([marker]) => prompt.includes(marker))![1];
		calls.push({ provider: model.provider, step, prompt });
		onStep(step);
		const failed = fail(model.provider, step);
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text: step }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? "402 insufficient credits" : undefined,
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
	let tool: any;
	registerFeaturePlanTool({ registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI);
	const runPlan = (signal?: AbortSignal) => {
		calls.length = 0;
		return tool.execute("test", { idea: "test architect flow", herdr: false }, signal, undefined, {
			cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
		});
	};
	const promptOf = (step: string) => calls.find(c => c.step === step)?.prompt ?? "";

	const plan = await runPlan();
	const [draft, preMortem, challenge, final] = plan.details.items as WorkerResult[];
	assert.deepEqual([draft.model, challenge.model, final.model], ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"]);
	assert.match(preMortem.model!, /deepseek/i);
	assert.match(promptOf("PREMORTEM-TEXT"), /DRAFT-TEXT/);
	assert.match(promptOf("CHALLENGE-TEXT"), /DRAFT-TEXT[\s\S]*PREMORTEM-TEXT/);
	assert.match(promptOf("FINAL-TEXT"), /DRAFT-TEXT[\s\S]*PREMORTEM-TEXT[\s\S]*CHALLENGE-TEXT/);
	assert.equal(plan.content[0].text, "FINAL-TEXT");
	assert.equal(plan.details.aggregated, true);
	assert.equal(plan.usage.totalTokens, 8);

	// Architect fails over to Opus; the challenger must not reuse it.
	fail = (provider, step) => provider === "openai-codex" && step === "DRAFT-TEXT";
	const swapped = (await runPlan()).details.items as WorkerResult[];
	assert.equal(swapped[0].model, "anthropic/claude-opus-5-5");
	assert.notEqual(modelIdentity(swapped[2].model!), modelIdentity(swapped[0].model!));

	// The final step falls back, but never onto the challenger's model.
	fail = (_provider, step) => step === "FINAL-TEXT";
	const noFinal = await runPlan();
	assert.ok(!calls.some(c => c.step === "FINAL-TEXT" && c.provider === "anthropic"));
	assert.deepEqual(calls.filter(c => c.step === "FINAL-TEXT").map(c => c.provider), ["openai-codex", "openai-codex", "aperture", "synthetic"]);
	assert.equal(noFinal.details.aggregated, false);
	assert.match(noFinal.content[0].text, /## Architect draft\n\nDRAFT-TEXT[\s\S]*PREMORTEM-TEXT[\s\S]*CHALLENGE-TEXT/);

	fail = (_provider, step) => step === "CHALLENGE-TEXT";
	const noChallenge = await runPlan();
	assert.equal(noChallenge.content[0].text, "FINAL-TEXT", "final plan still runs without a challenge");
	assert.match(promptOf("FINAL-TEXT"), /DESIGN CHALLENGE:\\n\(unavailable:/);

	// Anthropic and OpenAI out of credits: GLM drafts and finalizes; the challenger cannot reuse it.
	fail = (provider) => provider === "anthropic" || provider === "openai-codex";
	const glm = (await runPlan()).details.items as WorkerResult[];
	assert.deepEqual([glm[0].model, glm[2].status, glm[3].model], ["aperture/neuralwatt/glm-5.3", "error", "aperture/neuralwatt/glm-5.3"]);

	fail = (_provider, step) => step === "DRAFT-TEXT";
	const noDraft = await runPlan();
	assert.equal(noDraft.details.items.length, 1, "no downstream steps without a draft");
	assert.match(noDraft.content[0].text, /architect draft failed/);

	fail = () => false;
	const controller = new AbortController();
	onStep = (step) => { if (step === "DRAFT-TEXT") controller.abort(); };
	const aborted = await runPlan(controller.signal);
	assert.equal(aborted.details.items.length, 1);
	assert.match(aborted.content[0].text, /aborted during the architect draft/);
});

test("PR fix schema advertises opt-in commits", () => {
	let tool: any;
	registerPrReviewTool({
		registerTool: (value: unknown) => {
			tool = value;
		},
	} as ExtensionAPI);
	assert.match(tool.parameters.properties.fix.description, /default false/);
});
