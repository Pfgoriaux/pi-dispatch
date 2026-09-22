import assert from "node:assert/strict";
import test from "node:test";
import { DispatchProgress } from "../src/progress.ts";
import { renderDispatchCall, renderDispatchResult } from "../src/render.ts";
import type { DispatchDetails, WorkerResult } from "../src/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const result: WorkerResult = {
	agent: "scout",
	task: "inspect",
	status: "ok",
	text: "private final report",
	model: "vendor/model-a",
	attempts: 1,
	ms: 25,
};

test("call header identifies roles before any worker finishes", () => {
	const view = renderDispatchCall(
		{
			tasks: [
				{ agent: "scout", task: "Inspect files" },
				{ agent: "reviewer", task: "Review code", model: "precise" },
			],
		},
		theme,
		{},
	);
	const text = view.render(120).join("\n");
	assert.match(text, /1\. scout/);
	assert.match(text, /2\. reviewer.*requested precise/);
});

test("queued, selected model, failover and completion are visible without expansion", async () => {
	const updates: {
		content: { type: "text"; text: string }[];
		details: DispatchDetails;
	}[] = [];
	const progress = new DispatchProgress(
		"parallel",
		[
			{ agent: "scout", task: "inspect", herdr: false },
			{ agent: "reviewer", task: "review", herdr: false },
		],
		(update) => updates.push(update),
	);
	assert.equal(updates[0].details.activity?.[0].status, "queued");
	progress.start(0);
	progress.options(0).onAttempt("vendor/model-a", "low", 1);
	const first = updates.at(-1)!;
	progress.options(0).onAttempt("other/model-b", "high", 2);
	assert.equal(
		first.details.activity?.[0].model,
		"vendor/model-a",
		"snapshots must not mutate",
	);
	const view = renderDispatchResult(
		updates.at(-1)!,
		{ expanded: false },
		theme,
		{},
	);
	const text = view.render(120).join("\n");
	assert.match(text, /scout.*other\/model-b.*high.*running.*attempt 2/);
	assert.match(text, /reviewer.*queued/);
	assert.match(text, /0\/2/);
	await progress.finish(0, result);
	assert.match(
		renderDispatchResult(updates.at(-1)!, { expanded: false }, theme, {})
			.render(120)
			.join("\n"),
		/1\/2/,
	);
	assert.ok(
		updates.every(
			(u) => !JSON.stringify(u.content).includes("private final report"),
		),
		"progress content must not carry worker output",
	);
	await progress.end();
});

test("thrown worker failures preserve the last selected model and retry count", async () => {
	const progress = new DispatchProgress("single", [{ agent: "scout", task: "inspect", herdr: false }]);
	try {
		const failed = await progress.run(0, async () => {
			progress.options(0).onAttempt("provider/model-b", "high", 2);
			throw new Error("worker failed after retry");
		});
		assert.equal(failed.status, "error");
		assert.equal(failed.model, "provider/model-b");
		assert.equal(failed.thinking, "high");
		assert.equal(failed.attempts, 2);
	} finally { await progress.end(); }
});

test("workflow messages without worker details remain readable", () => {
	const view = renderDispatchResult(
		{ content: [{ type: "text", text: "No changes to review." }] },
		{ expanded: false },
		theme,
		{},
	);
	assert.match(view.render(100).join("\n"), /No changes to review/);
});

test("failed task cannot reject sibling fan-out", async () => {
	const updates: DispatchDetails[] = [];
	const progress = new DispatchProgress(
		"parallel",
		[
			{ agent: "scout", task: "a" },
			{ agent: "scout", task: "b" },
		],
		(u) => updates.push(u.details),
	);
	const results = await Promise.all([
		progress.run(0, async () => {
			throw new Error("loader failed");
		}),
		progress.run(1, async () => result),
	]);
	assert.deepEqual(
		results.map((r) => r.status),
		["error", "ok"],
	);
	assert.equal(updates.at(-1)?.items.length, 2);
});
