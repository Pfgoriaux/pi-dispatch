import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { savePlanReport } from "../src/tools/plan-report.ts";
import { architectDraftTask, architectFinalTask } from "../src/tools/feature-plan-prompts.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

const savedPath = (text: string) => text.match(/Full report saved to: ([^\n]+)/)![1];

test("short and oversized reports survive intact in private, distinct files", async () => {
	const inputs = ["Small plan", "大".repeat(6000) + "\nFINAL CONTRACT"];
	const outputs = await Promise.all(inputs.map(savePlanReport));
	assert.equal(outputs[0].truncated, false);
	assert.equal(outputs[1].truncated, true);
	assert.doesNotMatch(outputs[1].text, /FINAL CONTRACT/);
	assert.doesNotMatch(outputs[1].text, /\uFFFD/);
	assert.match(outputs[1].text, /Do not restart feature_plan/);
	assert.notEqual(savedPath(outputs[0].text), savedPath(outputs[1].text));
	for (const [index, output] of outputs.entries()) {
		const file = savedPath(output.text);
		assert.ok(file.startsWith(join(process.env.PI_CODING_AGENT_DIR!, "pi-dispatch", "plans")));
		assert.equal(await readFile(file, "utf8"), inputs[index]);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	}
});

test("storage failure preserves the preview without claiming a saved file", async () => {
	const directory = join(process.env.PI_CODING_AGENT_DIR!, "pi-dispatch", "plans");
	await rm(directory, { recursive: true, force: true });
	await writeFile(directory, "not a directory");
	const output = await savePlanReport("x".repeat(13000));
	assert.equal(output.truncated, true);
	assert.match(output.text, /Report could not be saved/);
	assert.match(output.text, /details.items/);
	assert.doesNotMatch(output.text, /Full report saved to:/);
});

test("planning prompts scale contracts to scope without repeating loaded writer context", () => {
	const context = { cwd: "/repo", idea: "A graph", focus: "" };
	const draft = architectDraftTask(context);
	const final = architectFinalTask(context, "draft", "risk", "challenge");
	assert.match(draft, /small feature usually needs one or two/);
	assert.match(final, /not a fixed word limit/);
	assert.match(final, /Do not repeat AGENTS.md instructions or reminders/);
	assert.match(final, /not separate workers/);
	assert.match(final, /Read applicable AGENTS.md instructions first/, "in-process planners disable context loading");
	assert.doesNotMatch(final, /contract alone|under 10 KB|## Architecture|- Read first:/);
});
