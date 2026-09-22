import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DispatchSpaces, SPACE_REFRESH_MS, SPACE_ROW_COUNT, SPACE_TTL_MS, type SpaceWorker } from "../src/spaces.ts";
import { DispatchProgress } from "../src/progress.ts";

const scout: SpaceWorker = { index: 0, agent: "scout", status: "queued", attempts: 0 };

function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-spaces-test-"));
	const log = path.join(dir, "calls.jsonl");
	const variables = ["PATH", "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_TEST_WORKSPACE", "HERDR_TEST_FAIL_REPORT"];
	const before = new Map(variables.map((name) => [name, process.env[name]]));
	const owned: DispatchSpaces[] = [];
	const warnings: string[] = [];
	t.after(async () => {
		try { await Promise.all(owned.map((spaces) => spaces.end())); }
		finally {
			// Failed viewer tabs intentionally retain logs in production; remove our fixtures.
			for (const args of calls()) {
				if (args[0] !== "pane" || args[1] !== "run") continue;
				const logPath = args[3].match(/'([^']+)'$/)?.[1];
				if (logPath && path.basename(path.dirname(logPath)).startsWith("dispatch-")) {
					fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
				}
			}
			for (const [name, value] of before) {
				if (value === undefined) delete process.env[name]; else process.env[name] = value;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	fs.writeFileSync(path.join(dir, "herdr"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (args[0]==='pane' && args[1]==='current') console.log(JSON.stringify({result:{pane:{workspace_id:process.env.HERDR_TEST_WORKSPACE,pane_id:'caller:p0'}}}));
else if (args[0]==='workspace' && args[1]==='report-metadata' && process.env.HERDR_TEST_FAIL_REPORT==='1') {
 console.error(JSON.stringify({error:{message:'test transport failure'}})); process.exitCode=1;
}
else if (args[0]==='tab' && args[1]==='create') console.log(JSON.stringify({result:{tab:{tab_id:'viewer:t1'},root_pane:{pane_id:'viewer:p1'}}}));
`, { mode: 0o700 });
	process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = path.join(dir, "fake.sock");
	process.env.HERDR_TEST_WORKSPACE = "caller-workspace";
	delete process.env.HERDR_TEST_FAIL_REPORT;
	const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
	return {
		dir, warnings, calls,
		reports: () => calls().filter((args) => args[0] === "workspace" && args[1] === "report-metadata"),
		async open(workers: SpaceWorker[] = [scout], signal?: AbortSignal) {
			const spaces = await DispatchSpaces.create(workers, (warning) => warnings.push(warning), signal);
			if (spaces) owned.push(spaces);
			return spaces;
		},
	};
}

function tokens(args: string[]) {
	return args.filter((_, index) => args[index - 1] === "--token");
}

async function waitFor(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for fake Herdr");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("outside Herdr, opted-out and pre-aborted runs create no rows or commands", async (t) => {
	const f = fixture(t);
	process.env.HERDR_ENV = "0";
	assert.equal(await f.open(), null);
	process.env.HERDR_ENV = "1";
	assert.equal(await f.open([]), null);
	assert.equal(await f.open([scout], AbortSignal.abort()), null);
	const progress = new DispatchProgress("single", [{ agent: "scout", task: "private task", herdr: false }]);
	try { await progress.open(f.dir); } finally { await progress.end(); }
	assert.deepEqual(f.calls(), []);
});

test("actual progress events drive queued, model/attempt, terminal and cleanup rows", async (t) => {
	const f = fixture(t);
	const progress = new DispatchProgress("parallel", [
		{ agent: "scout", task: "PRIVATE TASK" },
		{ agent: "hidden", task: "HIDDEN TASK", herdr: false },
	]);
	try {
		await progress.open(f.dir);
		assert.deepEqual(tokens(f.reports()[0]), ["dispatch_1=○ scout-1"]);
		progress.start(0);
		progress.options(0).onAttempt("provider/family/model-b", "high", 2);
		await waitFor(() => f.reports().some((r) => tokens(r).includes("dispatch_1=▶ scout-1 · model-b · ↻2")));
		await progress.finish(0, { agent: "scout", task: "PRIVATE TASK", status: "error", text: "PRIVATE REPORT", error: "PRIVATE ERROR", attempts: 2, ms: 12 });
		assert.deepEqual(tokens(f.reports().at(-1)!), ["dispatch_1=✗ scout-1 · model-b · ↻2"]);
	} finally { await progress.end(); }
	assert.equal(tokens(f.reports().at(-1)!).length, 0);
	assert.equal(f.reports().at(-1)!.filter((arg) => arg === "--clear-token").length, SPACE_ROW_COUNT);
	assert.ok(f.reports().every((args) => args[2] === "caller-workspace"));
	assert.ok(!JSON.stringify(f.reports()).includes("PRIVATE"));
	assert.ok(!JSON.stringify(f.reports()).includes("hidden"));
	assert.deepEqual(f.warnings, []);
});

test("overlapping dispatches share rows; ending one preserves the other's workers", async (t) => {
	const f = fixture(t);
	const a = await f.open();
	const b = await f.open([{ ...scout, agent: "reviewer", status: "running", model: "provider/model" }]);
	assert.ok(a && b);
	assert.equal(tokens(f.reports().at(-1)!).length, 2);
	await a.end();
	assert.deepEqual(tokens(f.reports().at(-1)!), ["dispatch_1=▶ reviewer-1 · model"]);
	await a.update([{ ...scout, status: "running" }]);
	await b.end();
	assert.deepEqual(tokens(f.reports().at(-1)!), []);
	const seq = f.reports().map((r) => Number(r[r.indexOf("--seq") + 1]));
	assert.ok(seq.every((value, index) => index === 0 || value > seq[index - 1]));
});

test("different calling workspaces are never cleared by each other", async (t) => {
	const f = fixture(t);
	const a = await f.open();
	process.env.HERDR_TEST_WORKSPACE = "other-workspace";
	const b = await f.open();
	assert.ok(a && b);
	await a.end();
	assert.equal(f.reports().at(-1)![2], "caller-workspace");
	const lastOther = f.reports().filter((r) => r[2] === "other-workspace").at(-1)!;
	assert.equal(tokens(lastOther).length, 1);
});

test("long-running workers refresh TTL; closing stops the heartbeat", async (t) => {
	const f = fixture(t);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const spaces = await f.open();
	assert.ok(spaces);
	assert.equal(f.reports()[0][f.reports()[0].indexOf("--ttl-ms") + 1], String(SPACE_TTL_MS));
	t.mock.timers.tick(SPACE_REFRESH_MS);
	await waitFor(() => f.reports().length >= 2);
	await spaces.end();
	const count = f.reports().length;
	t.mock.timers.tick(SPACE_REFRESH_MS * 3);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(f.reports().length, count);
});

test("transport failures are non-fatal, surfaced, and retried on the next update", async (t) => {
	const f = fixture(t);
	process.env.HERDR_TEST_FAIL_REPORT = "1";
	const spaces = await f.open();
	assert.ok(spaces);
	assert.match(f.warnings[0], /test transport failure/);
	delete process.env.HERDR_TEST_FAIL_REPORT;
	await spaces.update([{ ...scout, status: "aborted" }]);
	assert.deepEqual(tokens(f.reports().at(-1)!), ["dispatch_1=◍ scout-1"]);
	await spaces.end();
});

test("ending during pending updates cannot resurrect rows; cleanup errors stay non-fatal", async (t) => {
	const f = fixture(t);
	const spaces = await f.open();
	assert.ok(spaces);
	const updates = Array.from({ length: 30 }, (_, index) => spaces.update([{ ...scout, attempts: index + 1 }]));
	await spaces.end();
	await Promise.all(updates);
	assert.deepEqual(tokens(f.reports().at(-1)!), []);
	const next = await f.open();
	assert.ok(next);
	process.env.HERDR_TEST_FAIL_REPORT = "1";
	await next.end();
	assert.match(f.warnings.at(-1)!, /test transport failure/);
	const count = f.reports().length;
	await next.update([scout]);
	await next.end();
	assert.equal(f.reports().length, count);
});

test("row counts are bounded, overflow explicit, burst updates coalesced", async (t) => {
	const f = fixture(t);
	const spaces = await f.open(Array.from({ length: 20 }, (_, index) => ({ ...scout, index })));
	assert.ok(spaces);
	assert.equal(tokens(f.reports()[0]).length, SPACE_ROW_COUNT);
	assert.match(tokens(f.reports()[0]).at(-1)!, /\+9 workers/);
	const before = f.reports().length;
	await Promise.all(Array.from({ length: 50 }, (_, i) => spaces.update([{ ...scout, status: "running", attempts: i + 1 }])));
	assert.match(tokens(f.reports().at(-1)!)[0], /↻50/);
	assert.ok(f.reports().length - before <= 2, "updates must not queue one subprocess per event");
});
