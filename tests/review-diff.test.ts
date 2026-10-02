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
	let failStep: string | undefined;
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		prompts.push(JSON.stringify(context));
		const failed = model.provider !== "openai-codex" || (failStep !== undefined && JSON.stringify(context).includes(failStep));
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
	const assertDistinct = (items: WorkerResult[]) => {
		const successful = items.filter(r => r.status === "ok");
		const identities = successful.map(r => modelIdentity(r.model!));
		assert.equal(new Set(identities).size, identities.length);
		assert.equal(successful.length, 2, "Astra and Sol succeed; duplicate fallback workers stop");
	};
	assertDistinct(result.details.items.slice(0, 6));
	assert.ok(result.details.items[0].attempts > 0, "security starts before other roles claim all its candidates");

	registerFeaturePlanTool({ registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI);
	const runPlan = async () => {
		prompts.length = 0;
		return tool.execute("test", { idea: "test architect flow", herdr: false }, undefined, undefined, {
			cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
		});
	};
	const promptWith = (marker: string) => prompts.filter(p => p.includes(marker)).at(-1) ?? "";

	const plan = await runPlan();
	const [draft, preMortem, challenge, final] = plan.details.items as WorkerResult[];
	assert.equal(plan.details.items.length, 4);
	assert.equal(draft.model, "openai-codex/gpt-6-astra", "architect defaults to Astra");
	assert.equal(final.model, draft.model, "the draft's architect writes the final plan");
	assert.notEqual(modelIdentity(challenge.model!), modelIdentity(draft.model!), "challenger never shares the architect's model");
	assert.equal(preMortem.status, "ok");
	assert.match(promptWith("Run a pre-mortem"), /Three months later it broke/);
	assert.match(promptWith("Challenge this feature design"), /PRE-MORTEM/);
	assert.match(promptWith("Finalize your design"), /Decisions for you/);
	assert.equal(plan.details.aggregated, true);
	assert.match(plan.content[0].text, /Models: architect: openai-codex\/gpt-6-astra/);

	failStep = "Challenge this feature design";
	const noChallenge = await runPlan();
	assert.equal(noChallenge.details.items[2].status, "error");
	assert.equal(noChallenge.details.items[3].status, "ok", "final plan still runs without a challenge");
	assert.match(promptWith("Finalize your design"), /DESIGN CHALLENGE:\\n\(unavailable:/);

	failStep = "Finalize your design";
	const noFinal = await runPlan();
	assert.equal(noFinal.details.aggregated, false);
	assert.match(noFinal.content[0].text, /## Architect draft[\s\S]*## Pre-mortem[\s\S]*## Design challenge/);
	assert.match(noFinal.content[0].text, /final architect step failed/);

	failStep = "You are the architect for this feature";
	const noDraft = await runPlan();
	assert.equal(noDraft.details.items.length, 1, "no downstream steps without a draft");
	assert.match(noDraft.content[0].text, /architect draft failed/);
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
