import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { resolveDiff, registerPrReviewTool } from "../src/tools/pr-review.ts";
import { registerFeaturePlanTool } from "../src/tools/feature-plan.ts";
import { modelIdentity } from "../src/model-diversity.ts";
import type { WorkerResult } from "../src/types.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

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
	const models: string[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		prompts.push(JSON.stringify(context));
		models.push(`${model.provider}/${model.id}`);
		// Anthropic and OpenAI are out of credits; only GLM answers.
		const failed = !/glm-5\.3/i.test(model.id);
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
	assert.equal([opus, astra].filter(r => r.status === "ok").length, 1, "only one code reviewer may take the shared GLM fallback");
	assert.ok(!models.some(m => m.includes("gpt-6.1-sol")), "workflows never use Sol");
	assert.equal(preMortem.status, "ok", "pre-mortem falls back outside the reviewer guard");
	assert.equal(slop.status, "ok", "slop falls back outside the reviewer guard");
	assert.equal(result.details.items.length, 5, "four parallel steps, then one verify-aggregate step");
	assert.equal(result.details.items[4].status, "ok");
	const preMortemPrompt = prompts.find(p => p.includes("Run a pre-mortem")) ?? "";
	assert.match(preMortemPrompt, /Start with the diff/);
	assert.match(preMortemPrompt, /direct callers and dependencies, and relevant tests/);
	assert.match(preMortemPrompt, /Do not audit the whole repository/);
	assert.match(preMortemPrompt, /only to investigate a concrete risk/);
	assert.match(preMortemPrompt, /at most 3 likely failures/);
	assert.match(preMortemPrompt, /cite file:line evidence/);
	assert.match(preMortemPrompt, /preventive change or check/);
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
	let report = (step: string) => step;
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
			content: failed ? [] : [{ type: "text", text: report(step) }],
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
			sessionManager: { getSessionFile: () => "/sessions/plan-recovery.jsonl" },
		});
	};
	const promptOf = (step: string) => calls.find(c => c.step === step)?.prompt ?? "";

	const plan = await runPlan();
	const [draft, preMortem, challenge, final] = plan.details.items as WorkerResult[];
	assert.deepEqual([draft.model, challenge.model, final.model], ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"]);
	assert.match(preMortem.model!, /deepseek/i);
	assert.match(promptOf("PREMORTEM-TEXT"), /DRAFT-TEXT/);
	assert.match(promptOf("PREMORTEM-TEXT"), /Start with the draft design/);
	assert.match(promptOf("PREMORTEM-TEXT"), /direct callers and dependencies, and relevant tests/);
	assert.match(promptOf("PREMORTEM-TEXT"), /Do not audit the whole repository/);
	assert.match(promptOf("PREMORTEM-TEXT"), /only to investigate a concrete risk/);
	assert.match(promptOf("PREMORTEM-TEXT"), /at most 3 likely failures/);
	assert.match(promptOf("PREMORTEM-TEXT"), /cite the draft section and supporting code paths\/lines/);
	assert.match(promptOf("PREMORTEM-TEXT"), /preventive design change or check/);
	assert.match(promptOf("CHALLENGE-TEXT"), /DRAFT-TEXT[\s\S]*PREMORTEM-TEXT/);
	assert.match(promptOf("FINAL-TEXT"), /DRAFT-TEXT[\s\S]*PREMORTEM-TEXT[\s\S]*CHALLENGE-TEXT/);
	assert.match(plan.content[0].text, /^FINAL-TEXT\n\nFull report saved to: /);
	assert.equal(plan.details.aggregated, true);
	assert.equal(plan.usage.totalTokens, 8);

	// Architect fails over to Opus; the challenger must not reuse it.
	fail = (provider, step) => provider === "openai-codex" && step === "DRAFT-TEXT";
	const swapped = (await runPlan()).details.items as WorkerResult[];
	assert.equal(swapped[0].model, "anthropic/claude-opus-5-5");
	assert.notEqual(modelIdentity(swapped[2].model!), modelIdentity(swapped[0].model!));

	// The final step falls back, but never onto the challenger's model.
	fail = (_provider, step) => step === "FINAL-TEXT";
	// Sol is excluded from every workflow step.
	const noFinal = await runPlan();
	assert.ok(!calls.some(c => c.step === "FINAL-TEXT" && c.provider === "anthropic"));
	assert.deepEqual(calls.filter(c => c.step === "FINAL-TEXT").map(c => c.provider), ["openai-codex", "aperture", "synthetic"]);
	assert.equal(noFinal.details.aggregated, false);
	assert.match(noFinal.content[0].text, /## Architect draft\n\nDRAFT-TEXT[\s\S]*PREMORTEM-TEXT[\s\S]*CHALLENGE-TEXT/);

	fail = (_provider, step) => step === "CHALLENGE-TEXT";
	const noChallenge = await runPlan();
	assert.match(noChallenge.content[0].text, /^FINAL-TEXT\n\nFull report saved to: /, "final plan still runs without a challenge");
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
	report = (step) => `${step}\n${"é".repeat(8000)}\nEND-${step}`;
	const large = await runPlan();
	assert.equal(large.details.truncated, true);
	assert.equal(calls.length, 4, "oversized reports do not restart planning");
	const savedPath = (text: string) => text.match(/Full report saved to: ([^\n]+)/)![1];
	assert.equal(fs.readFileSync(savedPath(large.content[0].text), "utf8"), report("FINAL-TEXT"));
	assert.match(promptOf("CHALLENGE-TEXT"), /Read the complete file with offset\/limit/);
	assert.match(promptOf("FINAL-TEXT"), /Do not restart feature_plan/);
	assert.match(tool.promptGuidelines.join("\n"), /Recover existing text instead of restarting planning/);
	report = (step) => step;

	const controller = new AbortController();
	onStep = (step) => { if (step === "DRAFT-TEXT") controller.abort(); };
	const aborted = await runPlan(controller.signal);
	assert.equal(aborted.details.items.length, 1);
	assert.match(aborted.content[0].text, /aborted during the architect draft/);

	const directory = path.join(process.env.PI_CODING_AGENT_DIR!, "pi-dispatch", "plans");
	for (const [index, target] of ["DRAFT-TEXT", "PREMORTEM-TEXT", "CHALLENGE-TEXT", "FINAL-TEXT"].entries()) {
		fs.rmSync(directory, { recursive: true, force: true });
		report = (step) => step === target ? `${step}${"x".repeat(13000)}END` : step;
		onStep = (step) => {
			if (step !== target) return;
			fs.rmSync(directory, { recursive: true, force: true });
			fs.mkdirSync(path.dirname(directory), { recursive: true });
			fs.writeFileSync(directory, "not a directory");
		};
		const unsaved = await runPlan();
		assert.equal(calls.length, index + 1, "no downstream step receives an unrecoverable truncated input");
		assert.equal(unsaved.details.aggregated, false);
		assert.equal(unsaved.details.truncated, true);
		assert.equal(unsaved.details.items[index].text, report(target));
		assert.equal(unsaved.details.items[index].status, "ok", "storage failure does not rewrite model status");
		assert.ok(unsaved.content[0].text.startsWith(target), "retain the completed report preview");
		assert.match(unsaved.content[0].text, /Report could not be saved/);
		assert.match(unsaved.content[0].text, /\/sessions\/plan-recovery.jsonl/);
	}
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

test("pr_review runs Git in a cwd inside a non-Git session folder", async (t) => {
	const session = fs.realpathSync(fixture(t));
	const repo = path.join(session, "repo");
	execFileSync("git", ["init", "-q", repo]);
	const outside = fs.realpathSync(fixture(t));
	const cwds: (string | undefined)[] = [];
	let tool: any;
	registerPrReviewTool({
		registerTool: (value: unknown) => { tool = value; },
		exec: async (_cmd: string, _args: string[], options: { cwd?: string }) => {
			cwds.push(options.cwd);
			return { code: 128, stdout: "", stderr: "diff sentinel", killed: false };
		},
	} as unknown as ExtensionAPI);
	const run = (cwd?: string) => tool.execute("test", { pr: "main...HEAD", cwd, herdr: false }, undefined, undefined, {
		cwd: session, isProjectTrusted: () => false,
	});
	await assert.rejects(run(), /is not a git repository[\s\S]*Pass cwd/);
	await assert.rejects(run(outside), /outside the session cwd/);
	assert.deepEqual(cwds, [], "rejected cwds never reach Git");
	await assert.rejects(run("repo"), /diff sentinel/);
	assert.deepEqual(cwds, [repo]);
});
