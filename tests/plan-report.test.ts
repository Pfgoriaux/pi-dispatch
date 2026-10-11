import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { savePlanReport } from "../src/tools/plan-report.ts";
import {
	architectDraftTask, architectFinalTask,
	HETZNER_DRAFT_GUIDANCE, HETZNER_MODEL_GUIDANCE, HETZNER_TASK_PROMPT_TEMPLATE,
} from "../src/tools/feature-plan-prompts.ts";
import { registerDurableBatchTool } from "../src/tools/durable-batch.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

const savedPath = (text: string) => text.match(/Full report saved to: ([^\n]+)/)![1];

test("short and oversized reports survive intact in private, distinct files", async () => {
	const inputs = ["Small plan", "大".repeat(6000) + "\nFINAL CONTRACT"];
	const outputs = await Promise.all(inputs.map((text) => savePlanReport(text)));
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
	const read = createReadTool(process.cwd());
	const recovered = await read.execute("recover", {
		path: savedPath(outputs[1].text), offset: 2, limit: 1,
	});
	assert.ok(recovered.content.some((part) => part.type === "text" && part.text.includes("FINAL CONTRACT")),
		"the worker's SDK read tool can recover omitted contracts outside its cwd");
});

test("storage failure preserves the preview without claiming a saved file", async () => {
	const directory = join(process.env.PI_CODING_AGENT_DIR!, "pi-dispatch", "plans");
	await rm(directory, { recursive: true, force: true });
	await writeFile(directory, "not a directory");
	const output = await savePlanReport("x".repeat(13000), "/sessions/recover.jsonl");
	assert.equal(output.truncated, true);
	assert.match(output.text, /Report could not be saved/);
	assert.match(output.text, /details.items/);
	assert.match(output.text, /\/sessions\/recover.jsonl/);
	assert.doesNotMatch(output.text, /Full report saved to:/);
	const withoutSession = await savePlanReport("x".repeat(13000));
	assert.match(withoutSession.text, /No persisted session path is available/);
	const short = await savePlanReport("complete short plan");
	assert.equal(short.truncated, false);
	assert.match(short.text, /complete short plan/);
	assert.match(short.text, /complete report is shown above/);
	assert.doesNotMatch(short.text, /recover|details.items|incomplete/);
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

test("tool and architect prompts share the exact self-contained Hetzner drafting guide", () => {
	let tool: any;
	registerDurableBatchTool({ registerTool: (value: unknown) => { tool = value; }, on: () => {} } as any);
	const context = { cwd: "/repo", idea: "A graph", focus: "" };
	const guidance = [tool.description, tool.promptGuidelines.join("\n"), architectDraftTask(context), architectFinalTask(context, "draft", "risk", "challenge")];
	const headings = ["Goal", "Context", "Change", "Contracts", "Do not", "Checks", "Commit", "Report"];
	assert.deepEqual([...HETZNER_TASK_PROMPT_TEMPLATE.matchAll(/^## (.+)$/gm)].map((match) => match[1]), headings);
	const mapping = [
		'| `long` | `aperture/neuralwatt/kimi-k3` | `aperture/neuralwatt/glm-5.3` | `["aperture/synthetic/hf:moonshotai/Kimi-K3"]` |',
		'| Small/bounded GLM | `aperture/neuralwatt/glm-5.3` | `aperture/neuralwatt/kimi-k3` | None |',
		'| `precise` | Keep local; do not draft for Hetzner | — | — |',
	];
	for (const text of guidance) {
		assert.ok(text.includes(HETZNER_DRAFT_GUIDANCE));
		assert.ok(text.includes(HETZNER_TASK_PROMPT_TEMPLATE));
		assert.ok(text.includes(HETZNER_MODEL_GUIDANCE));
		for (const row of mapping) assert.ok(text.includes(row), row);
		assert.match(text, /limits.maxAttemptsPerTask: 2/);
		assert.match(text, /GLM has no equivalent Synthetic route on Aperture; do not propose a GLM fallback/);
		assert.doesNotMatch(text, /synthetic\/hf:zai-org\/GLM/);
		assert.match(text, /one concern per task/);
		assert.match(text, /ownedFiles small and bounded: exact files or narrow directories/);
		assert.match(text, /Independent tasks use dependencies: \[\] so they run in parallel/);
		assert.match(text, /Express real ordering only through dependencies/);
		assert.match(text, /No task may require a product or design decision/);
		assert.match(text, /unresolved decisions in planning and take them to the user before drafting executable tasks/);
		assert.match(text, /Precise-tier work stays local; never draft it for Hetzner/);
		assert.match(text, /workers see only their task prompt, not the plan or this conversation/);
		assert.match(text, /fully self-contained.*plain, literal language, exact identifiers and paths/);
		assert.match(text, /Do not refer to the plan, other tasks' internals, or the conversation; never use 'as discussed'/);
		assert.match(text, /Checks must match that task's checks argv/);
		assert.match(text, /not automatic configuration rewriting, provider validation, or routing/);
	}
});

test("README documents the shared prompt template and literal model table", async () => {
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	assert.ok(readme.includes(HETZNER_TASK_PROMPT_TEMPLATE));
	const table = HETZNER_MODEL_GUIDANCE.split("\n").filter((line) => line.startsWith("|"));
	for (const row of table) assert.ok(readme.includes(row), row);
});
