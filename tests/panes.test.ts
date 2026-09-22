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
	fs.writeFileSync(
		path.join(dir, "herdr"),
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.appendFileSync(log, JSON.stringify(args)+'\\n');
if (args[0]==='pane' && args[1]==='current') console.log(JSON.stringify({result:{pane:{workspace_id:'w-test',pane_id:'w-test:p0'}}}));
else if (args[0]==='tab' && args[1]==='create') {
 const i = calls.filter(c=>c[0]==='tab'&&c[1]==='create').length+1;
 console.log(JSON.stringify({result:{tab:{tab_id:'w-test:t'+i},root_pane:{pane_id:'w-test:p'+i}}}));
}
// pane run, report-agent and tab close succeed with no JSON output.
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
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
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
