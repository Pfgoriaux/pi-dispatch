import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DispatchPanes } from "../src/panes.ts";

for (const status of ["ok", "error", "aborted"] as const) {
test(`viewer tabs clean up ${status} and unfinished workers without Git`, async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-herdr-test-"));
	const log = path.join(dir, "calls.jsonl");
	const oldPath = process.env.PATH;
	const oldHerdr = process.env.HERDR_ENV;
	const oldSocket = process.env.HERDR_SOCKET_PATH;
	t.after(() => {
		process.env.PATH = oldPath;
		if (oldHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = oldHerdr;
		if (oldSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = oldSocket;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	// A shell fake starts in milliseconds; a Node fake can exceed herdrCommand's 5 s timeout on a loaded machine.
	// Each call is logged as arguments joined by US (\x1f) and terminated by RS (\x1e).
	fs.writeFileSync(
		path.join(dir, "herdr"),
		`#!/bin/sh
printf '%s\\037' "$@" >> '${log}'
printf '\\036' >> '${log}'
if [ "$1" = pane ] && [ "$2" = current ]; then
 printf '%s\\n' '{"result":{"pane":{"workspace_id":"w-test","pane_id":"w-test:p0"}}}'
elif [ "$1" = tab ] && [ "$2" = create ]; then
 echo x >> '${log}.tabs'
 i=$(wc -l < '${log}.tabs' | tr -d ' ')
 printf '{"result":{"tab":{"tab_id":"w-test:t%s"},"root_pane":{"pane_id":"w-test:p%s"}}}\\n' "$i" "$i"
fi
# pane run, report-agent and tab close succeed with no JSON output.
`,
		{ mode: 0o700 },
	);
	process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = path.join(dir, "fake.sock");
	const warnings: string[] = [];
	const panes = await DispatchPanes.create(
		[
			{ index: 0, agent: "scout", task: "inspect" },
			{ index: 1, agent: "reviewer", task: "review" },
		],
		dir,
		"smoke",
		(warning) => warnings.push(warning),
	);
	assert.ok(panes);
	try {
		panes.start(0, "vendor/model");
		await panes.finish(0, {
			agent: "scout",
			task: "inspect",
			status,
			text: "done",
			attempts: 1,
			ms: 10,
		});
	} finally {
		await panes.end();
	}
	assert.deepEqual(warnings, []);
	const calls = fs
		.readFileSync(log, "utf8")
		.split("\x1e")
		.filter(Boolean)
		.map((record) => record.split("\x1f").slice(0, -1));
	assert.equal(
		calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
		2,
	);
	assert.equal(
		calls.filter((c) => c[0] === "tab" && c[1] === "close").length,
		2,
	);
	assert.ok(!calls.some((c) => c[0] === "worktree"));
	assert.ok(
		calls
			.filter((c) => c[1] === "create")
			.every((c) => c.includes("--no-focus") && c.includes("w-test")),
	);
	const tail = calls.find((c) => c[0] === "pane" && c[1] === "run")!;
	const logPath = tail[3].match(/'([^']+)'$/)![1];
	assert.equal(
		fs.existsSync(path.dirname(logPath)),
		false,
		"ended run must remove its log artifacts regardless of worker status",
	);
});
}
