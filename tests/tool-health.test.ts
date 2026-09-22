import assert from "node:assert/strict";
import test from "node:test";
import { ToolHealth } from "../src/tool-health.ts";

const end = (toolName: string, isError = true) => ({ type: "tool_execution_end" as const, toolName, isError });

test("invalid names are counted across changing guesses and never echoed into logs", () => {
	const health = new ToolHealth(["read", "ls"]);
	for (const name of ["read</arg_value>", "read private/path.mjs</arg_value>", "db\nsecret"]) {
		assert.equal(health.format(end(name)), "tool_execution_end: [unregistered tool] [error]");
		health.observe(end(name));
	}
	assert.match(health.failure!, /3 consecutive calls to unavailable tools/);
	assert.ok(!health.failure!.includes("private"));
	assert.equal(health.format(end("read")), "tool_execution_end: read [error]");
	assert.equal(health.format(end("read", false)), "tool_execution_end: read [ok]");
	assert.equal(health.format({ type: "tool_execution_start", toolName: "ls" }), "tool_execution_start: ls");
});

test("valid results reset streaks; registered tool errors are also bounded", () => {
	const health = new ToolHealth(["read", "ls"]);
	for (let i = 0; i < 4; i++) {
		health.observe(end("bad"));
		health.observe(end("other"));
		health.observe(end("read", false));
		assert.equal(health.failure, undefined);
	}
	for (let i = 0; i < 4; i++) {
		health.observe(end(i % 2 ? "ls" : "read"));
		assert.equal(health.failure, undefined);
	}
	health.observe(end("read"));
	assert.match(health.failure!, /5 consecutive tool errors/);
	const failure = health.failure;
	health.observe(end("read", false));
	assert.equal(health.failure, failure, "cutoff cannot be undone by another parallel completion");
});
