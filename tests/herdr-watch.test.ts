import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HerdrWatcher, registerHerdrWatch, type WatchedAgent, type Watch } from "../src/herdr-watch.ts";

const agent = (status = "working", pane = "w1:p2"): WatchedAgent => ({
	pane_id: pane, workspace_id: "w1", terminal_id: `term-${pane}`, agent: "pi",
	agent_session: { kind: "path", value: `/tmp/${pane}.jsonl` }, agent_status: status,
});
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
};

test("working workers cause no messages; all settled siblings arrive in one one-shot notice", async () => {
	let status = "working";
	const notices: string[][] = [];
	let saved: Watch[] = [];
	const watcher = new HerdrWatcher(async target => agent(status, target), watches => { saved = watches; }, lines => notices.push(lines));
	await watcher.add(["w1:p2", "w1:p3"], "w1", "w1:p1");
	await watcher.poll();
	assert.equal(notices.length, 0);
	status = "idle";
	await watcher.poll();
	assert.equal(notices.length, 1);
	assert.equal(notices[0].length, 2);
	assert.match(notices[0][0], /not proof the task succeeded/);
	assert.deepEqual(saved, []);
	await watcher.poll();
	assert.equal(notices.length, 1);
	status = "working";
	await watcher.add(["w1:p2"], "w1", "w1:p1");
	status = "blocked";
	await watcher.poll();
	assert.match(notices[1][0], /blocked/);
});

test("already-finished workers notify; replaced sessions never inherit old tasks", async () => {
	let current = agent("done");
	const notices: string[][] = [];
	const watcher = new HerdrWatcher(async () => current, () => {}, lines => notices.push(lines));
	await watcher.add(["worker"], "w1", "w1:p1");
	await watcher.poll();
	assert.equal(notices.length, 1);
	await watcher.add(["worker"], "w1", "w1:p1");
	current = { ...current, agent_session: { kind: "path", value: "/tmp/replacement.jsonl" } };
	await watcher.poll();
	assert.match(notices[1][0], /different session/);
	assert.equal(watcher.list().length, 0);
});

test("inspection failures and unknown states become bounded alerts, without raw CLI errors", async () => {
	let fail = false;
	let current = agent();
	const notices: string[][] = [];
	const watcher = new HerdrWatcher(async () => {
		if (fail) throw new Error("private CLI diagnostic");
		return current;
	}, () => {}, lines => notices.push(lines));
	await watcher.add(["worker"], "w1", "w1:p1");
	fail = true;
	await watcher.poll();
	await watcher.poll();
	assert.equal(notices.length, 0);
	await watcher.poll();
	assert.match(notices[0][0], /three checks/);
	assert.ok(!notices[0][0].includes("private"));
	fail = false;
	current = agent("unknown");
	await watcher.add(["worker"], "w1", "w1:p1");
	for (let i = 0; i < 3; i++) await watcher.poll();
	assert.match(notices[1][0], /unknown/);
});

test("registration rejects self, foreign workspaces, missing identity and cancellation", async () => {
	let current = agent();
	const watcher = new HerdrWatcher(async () => current, () => {}, () => {});
	await assert.rejects(watcher.add(["worker"], "w2", "w2:p1"), /workspace/);
	await assert.rejects(watcher.add(["worker"], "w1", "w1:p2"), /itself/);
	current = { ...agent(), agent_session: undefined };
	await assert.rejects(watcher.add(["worker"], "w1", "w1:p1"), /identity/);
	current = agent();
	await assert.rejects(watcher.add(["worker"], "w1", "w1:p1", AbortSignal.abort()), /cancelled/);
	assert.deepEqual(watcher.list(), []);
});

test("late polls cannot wake a switched session or consume a re-registered watch", async () => {
	let wait: ReturnType<typeof deferred<WatchedAgent>> | undefined;
	const notices: string[][] = [];
	const watcher = new HerdrWatcher(target => wait?.promise ?? Promise.resolve(agent("working", target)), () => {}, lines => notices.push(lines));
	await watcher.add(["w1:p2"], "w1", "w1:p1");
	wait = deferred();
	const stale = watcher.poll();
	watcher.reset();
	wait.resolve(agent("idle"));
	await stale;
	assert.equal(notices.length, 0);
	wait = undefined;
	await watcher.add(["w1:p2"], "w1", "w1:p1");
	wait = deferred();
	const previous = watcher.poll();
	const old = wait;
	wait = undefined;
	await watcher.add(["w1:p2"], "w1", "w1:p1");
	old.resolve(agent("idle"));
	await previous;
	assert.equal(notices.length, 0);
	assert.equal(watcher.list().length, 1);
});

test("failed notification delivery retains the watch for retry", async () => {
	let throws = true;
	const watcher = new HerdrWatcher(async () => agent("idle"), () => {}, () => {
		if (throws) throw new Error("queue unavailable");
	});
	await watcher.add(["worker"], "w1", "w1:p1");
	await assert.rejects(watcher.poll(), /queue unavailable/);
	assert.equal(watcher.list().length, 1);
	throws = false;
	await watcher.poll();
	assert.equal(watcher.list().length, 0);
});

test("extension queues a follow-up with triggerTurn, restores pending watches and stops on shutdown", async t => {
	const oldEnv = { ...process.env };
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/test.sock", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" });
	t.after(() => { process.env = oldEnv; });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	type Handler = (event: never, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler>();
	const notices: { content: string; options: unknown }[] = [];
	const entries: unknown[] = [];
	let tool!: ToolDefinition;
	let status = "working";
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (definition: ToolDefinition) => { tool = definition; },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { content: string }, options: unknown) => notices.push({ content: message.content, options }),
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "parent", getBranch: () => entries },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
	registerHerdrWatch(pi, async () => agent(status));
	await handlers.get("session_start")!(undefined as never, ctx);
	await tool.execute("watch", { action: "watch", targets: ["worker"] }, undefined, undefined, ctx);
	assert.equal(entries.length, 1);
	// Reload: restore the pending watch from session entries.
	await handlers.get("session_start")!(undefined as never, ctx);
	status = "idle";
	t.mock.timers.tick(3000);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(notices.length, 1);
	assert.deepEqual(notices[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(notices[0].content, /existing authorization/);
	await tool.execute("watch", { action: "watch", targets: ["worker"] }, undefined, undefined, ctx);
	handlers.get("session_shutdown")!(undefined as never, ctx);
	t.mock.timers.tick(3000);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(notices.length, 1);
});
