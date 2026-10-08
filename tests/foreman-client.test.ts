import test, { afterEach, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ForemanClient, ForemanError } from "../src/foreman-client.ts";
import { registerDurableBatchTool } from "../src/tools/durable-batch.ts";

const TOKEN = "fixture-bearer-token";
const HASH = "sha256:server-owned-hash";
const keys = ["FOREMAN_URL", "FOREMAN_TOKEN", "PI_DISPATCH_DEPTH"];
let saved: (string | undefined)[];
beforeEach(() => {
	saved = keys.map((key) => process.env[key]);
	delete process.env.FOREMAN_URL;
	delete process.env.PI_DISPATCH_DEPTH;
	process.env.FOREMAN_TOKEN = TOKEN;
});
afterEach(() => {
	keys.forEach((key, i) => {
		if (saved[i] === undefined) delete process.env[key];
		else process.env[key] = saved[i];
	});
});

const config = {
	batch: { id: "night-1", tasks: [{ id: "api", dependencies: [], ownedFiles: ["src/"], checks: [["npm", "test"]], prompt: "Fix the API" }] },
	repo: { root: "/repo", baseBranch: "feat/api", branchPrefix: "batch/night-1", worktreesRoot: "/worktrees", sessionsRoot: "/sessions" },
	worker: { piExecutable: "/bin/pi", model: "test/writer", thinking: "high", reviewModel: "test/reviewer", reviewThinking: "medium" },
	spend: { allowanceUsd: 20, reservations: { api: 5 } },
	limits: { maxWorkers: 1, maxAttemptsPerTask: 2, deadline: "2026-12-01T06:00:00Z" },
	publication: { repo: "owner/repo", remote: "origin", url: "git@example.invalid:owner/repo.git", gh: "/bin/gh" },
	store: "/store.sqlite",
};
const summary = ["Server approval summary", "Worker: server/writer; allowance $20"];
const created = { id: "night-1", policyHash: HASH, summary };
const batchStatus = (state = "pending") => ({ batch: { id: "night-1", policyHash: HASH, state, config, error: null as string | null }, owner: null, report: null as unknown });
interface Call { method: string; route: string; body: unknown; authorization?: string }
type Handler = (call: Call, response: http.ServerResponse) => void;
const json = (res: http.ServerResponse, body: unknown, status = 200) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};

async function fixture(t: TestContext, handler: Handler, socket?: string) {
	const calls: Call[] = [];
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString();
		const call = { method: req.method!, route: req.url!, body: raw ? JSON.parse(raw) : undefined, authorization: req.headers.authorization };
		calls.push(call);
		handler(call, res);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		if (socket) server.listen(socket, resolve);
		else server.listen(0, "127.0.0.1", resolve);
	});
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const address = server.address();
	process.env.FOREMAN_URL = typeof address === "string" ? `unix:${address}` : `http://127.0.0.1:${address!.port}`;
	return calls;
}

function batchTool(answer = true, hasUI = true) {
	let tool: any;
	let sessionStart: () => void = () => {};
	registerDurableBatchTool({
		registerTool: (value: unknown) => { tool = value; },
		on: (event: string, fn: () => void) => { if (event === "session_start") sessionStart = fn; },
	} as any);
	const asked: string[] = [];
	const ctx = { hasUI, ui: { confirm: async (title: string, message: string) => { asked.push(`${title}\n${message}`); return answer; } } };
	const result = (params: object) => tool.execute("id", params, undefined, undefined, ctx);
	const call = async (params: object): Promise<string> => (await result(params)).content[0].text;
	return { call, result, asked, sessionStart: () => sessionStart(), tool };
}

const normal: Handler = (call, res) => {
	if (call.route === "/batches") return json(res, created, 201);
	if (call.route.endsWith("/approve")) return json(res, { id: "night-1", state: "approved" });
	json(res, batchStatus());
};

test("draft forwards config unchanged and returns the server summary, ID, and hash", async (t) => {
	const calls = await fixture(t, normal);
	const { call, tool } = batchTool();
	const input = { arbitrary: "server validates this, not Pi" };
	const output = await call({ action: "draft", config: input });
	assert.equal(tool.executionMode, "sequential");
	assert.deepEqual(calls, [{ method: "POST", route: "/batches", body: input, authorization: `Bearer ${TOKEN}` }]);
	for (const value of [created.id, HASH, ...summary]) assert.ok(output.includes(value));
});

test("launch confirms the cached server summary and posts exactly the displayed hash", async (t) => {
	const calls = await fixture(t, normal);
	const { call, asked } = batchTool();
	await call({ action: "draft", config });
	assert.deepEqual(JSON.parse(await call({ action: "launch", id: created.id })), { id: created.id, state: "approved" });
	assert.equal(asked.length, 1);
	for (const line of [...summary, HASH]) assert.ok(asked[0].includes(line));
	assert.deepEqual(calls.map(({ method, route }) => [method, route]), [["POST", "/batches"], ["GET", "/batches/night-1"], ["POST", "/batches/night-1/approve"]]);
	assert.deepEqual(calls[2].body, { policyHash: HASH });
});

test("declining launch never sends approval", async (t) => {
	const calls = await fixture(t, normal);
	const { call, asked } = batchTool(false);
	assert.match(await call({ action: "launch", id: created.id }), /declined by the user; nothing started/);
	assert.equal(asked.length, 1);
	assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("launch refuses states other than pending or stopped before asking", async (t) => {
	let state = "approved";
	const calls = await fixture(t, (_call, res) => json(res, batchStatus(state)));
	const { call, asked } = batchTool();
	for (state of ["approved", "finished", "cancelled"]) assert.match(await call({ action: "launch", id: created.id }), new RegExp(`Launch refused:.*${state}`));
	assert.equal(asked.length, 0);
	assert.ok(calls.every((c) => c.method === "GET"));
});

test("launch without a cached draft uses GET config and accepts stopped batches", async (t) => {
	const calls = await fixture(t, (call, res) => {
		if (call.method === "GET") return json(res, batchStatus("stopped"));
		json(res, { state: "approved" });
	});
	const { call, asked } = batchTool();
	await call({ action: "launch", id: created.id });
	for (const value of ["(resume)", HASH, "/repo", "test/writer", "test/reviewer", "$20", "2026-12-01", "src/", '"npm" "test"', "Fix the API", "/store.sqlite", "owner/repo"]) assert.ok(asked[0].includes(value), value);
	assert.equal(calls.length, 2, "never re-create a batch to obtain its summary");
	assert.equal(calls[1].route, "/batches/night-1/approve");
});

test("session changes clear cached summaries", async (t) => {
	await fixture(t, normal);
	const tool = batchTool(false);
	await tool.call({ action: "draft", config });
	tool.sessionStart();
	await tool.call({ action: "launch", id: created.id });
	assert.doesNotMatch(tool.asked[0], /Server approval summary/);
	assert.match(tool.asked[0], /Fix the API/);
});

test("a changed server hash does not reuse a stale summary", async (t) => {
	await fixture(t, (call, res) => {
		if (call.route === "/batches") return json(res, created, 201);
		const status = batchStatus();
		status.batch.policyHash = "sha256:new-server-hash";
		json(res, status);
	});
	const tool = batchTool(false);
	await tool.call({ action: "draft", config });
	await tool.call({ action: "launch", id: created.id });
	assert.doesNotMatch(tool.asked[0], /Server approval summary/);
	assert.match(tool.asked[0], /sha256:new-server-hash/);
});

test("no UI and worker launches refuse without network requests or confirmation", async () => {
	const noUI = batchTool(true, false);
	assert.match(await noUI.call({ action: "launch", id: created.id }), /no interactive UI/);
	process.env.PI_DISPATCH_DEPTH = "1";
	const worker = batchTool();
	assert.match(await worker.call({ action: "launch", id: created.id }), /workers cannot launch/);
	assert.deepEqual([...noUI.asked, ...worker.asked], []);
});

test("HTTP errors preserve status and refusal details without exposing the token", async (t) => {
	let code = 401;
	await fixture(t, (_call, res) => json(res, { error: `Invalid bearer token ${TOKEN}`, refused: [`credential ${TOKEN}`] }, code));
	for (code of [401, 403, 404, 409, 422]) {
		await assert.rejects(new ForemanClient().request("GET", "/batches/night-1"), (error: unknown) => {
			assert.ok(error instanceof ForemanError);
			assert.equal(error.status, code);
			assert.match(error.message, new RegExp(`Foreman HTTP ${code}`));
			assert.doesNotMatch(JSON.stringify(error), new RegExp(TOKEN));
			assert.deepEqual(error.body.refused, ["credential [redacted]"]);
			return true;
		});
	}
	code = 401;
	const result = await batchTool().result({ action: "status", id: created.id });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Foreman HTTP 401: Invalid bearer token/);
	assert.doesNotMatch(result.content[0].text, new RegExp(TOKEN));
});

test("reflected credentials are redacted even when JSON escapes them", async (t) => {
	await fixture(t, (_call, res) => res.end(JSON.stringify({ reflected: TOKEN }).replace("fixture", "\\u0066ixture")));
	assert.deepEqual(await new ForemanClient().request("GET", "/batches/night-1"), { reflected: "[redacted]" });
});

test("failed approval returns the server error, never a launch success", async (t) => {
	const calls = await fixture(t, (call, res) => {
		if (call.method === "GET") return json(res, batchStatus());
		json(res, { error: "Policy hash differs from the approved configuration" }, 409);
	});
	const result = await batchTool().result({ action: "launch", id: created.id });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /409: Policy hash differs/);
	assert.equal(calls.length, 2, "no retry of approval");
});

test("status renders coordinator error, task states, attempts, spend, and PR", async (t) => {
	const status = batchStatus("stopped");
	status.batch.error = "deadline passed";
	status.report = {
		batchId: created.id, phase: "running", deadline: config.limits.deadline, spentUsd: 1.25, allowanceUsd: 20, halted: ["budget exhausted"], stopped: "review pending",
		tasks: [
			{ id: "api", state: "pr-ready", attempts: 2, spentUsd: 1.25, pr: { number: 7 }, reason: null },
			{ id: "docs", state: "blocked", attempts: 0, spentUsd: null, pr: null, reason: "dependency" },
		],
	};
	await fixture(t, (_call, res) => json(res, status));
	const output = await batchTool().call({ action: "status", id: created.id });
	assert.match(output, /Batch night-1: stopped\nError: deadline passed/);
	assert.match(output, /Accounted spend: \$1.25 of \$20.00/);
	assert.match(output, /pr-ready +api \(2 attempts, \$1.25\) PR #7/);
	assert.match(output, /blocked +docs \(0 attempts, unknown\).*dependency/);
	assert.match(output, /Stopped: review pending/);
	assert.match(output, /Halted: budget exhausted/);
});

test("status handles pending reports and truncates long UTF-8 text", async (t) => {
	const status = batchStatus();
	await fixture(t, (_call, res) => json(res, status));
	const { call } = batchTool();
	assert.equal(await call({ action: "status", id: created.id }), "Batch night-1: pending");
	status.batch.error = "界".repeat(10_000);
	const output = await call({ action: "status", id: created.id });
	assert.ok(Buffer.byteLength(output) < 13_000);
	assert.match(output, /truncated/i);
	assert.doesNotMatch(output, /�/);
});

test("stop posts cancel and returns both draining and cancelled replies", async (t) => {
	const calls = await fixture(t, (call, res) => {
		if ((call.body as { cancel: boolean }).cancel) return json(res, { state: "cancelled", draining: false });
		json(res, { state: "approved", draining: true }, 202);
	});
	const { call } = batchTool();
	assert.deepEqual(JSON.parse(await call({ action: "stop", id: created.id })), { state: "approved", draining: true });
	assert.deepEqual(JSON.parse(await call({ action: "stop", id: created.id, cancel: true })), { state: "cancelled", draining: false });
	assert.deepEqual(calls.map((c) => [c.method, c.route, c.body]), [["POST", "/batches/night-1/stop", { cancel: false }], ["POST", "/batches/night-1/stop", { cancel: true }]]);
});

test("missing or invalid environment settings fail clearly without leaking credentials", async () => {
	assert.throws(() => new ForemanClient(), /Set FOREMAN_URL/);
	const result = await batchTool().result({ action: "draft", config });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Set FOREMAN_URL/);
	for (const url of [`http://user:${TOKEN}@localhost`, `https://localhost/${TOKEN}`, `invalid-${TOKEN}`, "unix:relative"]) {
		assert.throws(() => new ForemanClient({ FOREMAN_URL: url, FOREMAN_TOKEN: TOKEN }), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /FOREMAN_URL/);
			assert.doesNotMatch(error.message, new RegExp(TOKEN));
			return true;
		});
	}
	assert.throws(() => new ForemanClient({ FOREMAN_URL: "http://localhost:1234" }), /Set FOREMAN_TOKEN/);
});

test("client supports HTTP over a Unix socket", async (t) => {
	const dir = fs.mkdtempSync(path.resolve(".foreman-test-"));
	try {
		const calls = await fixture(t, (_call, res) => json(res, created, 201), path.join(dir, "http.sock"));
		assert.deepEqual(await new ForemanClient().request("POST", "/batches", config), created);
		assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("client rejects invalid JSON and responses larger than 4 MiB", async (t) => {
	let oversized = false;
	await fixture(t, (_call, res) => res.end(oversized ? JSON.stringify("x".repeat(4 * 1024 * 1024)) : "not JSON"));
	await assert.rejects(new ForemanClient().request("GET", "/batches/night-1"), /invalid JSON/);
	oversized = true;
	await assert.rejects(new ForemanClient().request("GET", "/batches/night-1"), /exceeds 4 MiB/);
});

test("client bounds the entire request to 60 seconds", async (t) => {
	let received!: () => void;
	const ready = new Promise<void>((resolve) => { received = resolve; });
	await fixture(t, (_call, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.write("{");
		received();
	});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = assert.rejects(new ForemanClient().request("GET", "/batches/night-1"), /timed out after 60 seconds/);
	await ready;
	t.mock.timers.tick(60_000);
	await pending;
});
