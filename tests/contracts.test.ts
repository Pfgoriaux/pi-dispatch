import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import extension from "../src/index.ts";
import { architectFinalTask } from "../src/tools/feature-plan-prompts.ts";
import { WORKER_CONTRACT } from "../src/worker-prompt.ts";

test("orchestration is model-only and child prompts omit the coordinator roster", () => {
	const tools: any[] = [];
	let hook: any;
	extension({
		registerTool: (tool: any) => tools.push(tool),
		on: (name: string, handler: any) => { if (name === "before_agent_start") hook = handler; },
	} as any);
	for (const name of ["dispatch", "pr_review", "feature_plan", "council"])
		assert.equal(tools.find(t => t.name === name).exposure, "model-only", name);
	const previous = process.env.PI_DISPATCH_DEPTH;
	try {
		process.env.PI_DISPATCH_DEPTH = "1";
		assert.equal(hook({ systemPrompt: "child" }, {}), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_DISPATCH_DEPTH;
		else process.env.PI_DISPATCH_DEPTH = previous;
	}
});

test("writer contract stages named files and returns a branch without merging", () => {
	const writer = readFileSync(new URL("../agents/writer.md", import.meta.url), "utf8");
	assert.match(writer, /git add --/);
	assert.doesNotMatch(writer, /git add -A|git add \.|automatic merge-back/);
	assert.match(writer, /not merged automatically/);
	assert.match(WORKER_CONTRACT, /Do not start pi or other agent CLIs/);
	assert.match(architectFinalTask({ cwd: "/fixture", idea: "fixture", focus: "" }, "", "", ""), /- Repository:/);
});
