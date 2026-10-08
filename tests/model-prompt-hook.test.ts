import assert from "node:assert/strict";
import test from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAdaptedSystemPrompt } from "../src/model-prompts/adaptations.ts";
import modelPrompts from "../src/model-prompts/extension.ts";
import { knownModelFamily } from "../src/model-prompts/families.ts";

type Hook = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => { systemPrompt: string } | undefined;

function hook() {
	let callback: Hook | undefined;
	modelPrompts({
		on: (name: string, fn: Hook) => {
			assert.equal(name, "before_agent_start");
			callback = fn;
		},
	} as unknown as ExtensionAPI);
	return (id?: string, systemPrompt = "Role: read-only reviewer.") =>
		callback?.(
			{ type: "before_agent_start", systemPrompt } as BeforeAgentStartEvent,
			{ model: id ? { provider: "test", id } : undefined } as ExtensionContext,
		);
}

function prompt(result: ReturnType<ReturnType<typeof hook>>): string {
	assert.ok(result, "expected an adapted system prompt");
	return result.systemPrompt;
}

test("uses ctx.model, preserves the role, and follows model changes", () => {
	const run = hook();
	const first = prompt(run("gpt-6-astra"));
	assert.match(first, /Role: read-only reviewer\./);
	assert.match(first, /Model-specific guidance \(gpt-6-astra\)/);
	assert.match(first, /Complete required project checks/);
	assert.match(first, /your role permits delegation/);
	assert.match(first, /Respect requests to work without delegation or other models/);
	const next = prompt(run("hf:moonshotai/Kimi-K3"));
	assert.match(next, /Model-specific guidance \(kimi-k3\)/);
	assert.doesNotMatch(next, /Model-specific guidance \(gpt-6-astra\)/);
	assert.equal(run("unknown"), undefined);
	assert.equal(run(), undefined);
	assert.equal(run("gpt-6-astra", first), undefined);
});

test("selects each Claude adaptation without changing role or duplicating guidance", () => {
	const run = hook();
	const fable = prompt(run("neuralwatt/fable-5.1"));
	assert.match(fable, /Model-specific guidance \(claude-fable-5\.1\)/);
	assert.match(fable, /Prefer targeted edits/);
	assert.match(fable, /When the role and output format allow progress updates/);
	assert.match(fable, /Role: read-only reviewer\./);
	assert.equal(run("claude-fable-5-1", fable), undefined);
	const opus = prompt(run("claude-opus-5-5"));
	assert.match(opus, /required commands or delegated work are still pending/);
	assert.doesNotMatch(opus, /Model-specific guidance \(claude-fable-5\.1\)/);
	const sonnet = prompt(run("claude-sonnet-5-5"));
	assert.match(sonnet, /A superficial syntax check or a command that failed to start is not verification/);
	assert.match(sonnet, /unless a review is requested or required by applicable instructions/);
	for (const id of ["claude-sonnet-5", "claude-opus-4-5", "claude-opus-4.5"]) assert.equal(run(id), undefined, id);
});

test("switches from Astra to 6.1 Sol guidance", () => {
	const run = hook();
	run("gpt-6-astra");
	const next = prompt(run("gpt-6.1-sol"));
	assert.match(next, /Model-specific guidance \(gpt-6\.1-sol\)/);
	assert.match(next, /do not substitute a best guess/);
	assert.doesNotMatch(next, /Model-specific guidance \(gpt-6-astra\)/);
});

test("leaves retired GPT-6 models unchanged", () => {
	for (const id of ["gpt-6", "gpt-6-sol", "gpt-6-luna"]) assert.equal(hook()(id), undefined, id);
});

test("every adaptation preserves permission boundaries and appears once", () => {
	const ids = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6.1-sol", "glm-5.3", "kimi-k3", "deepseek-v4.1-flash"];
	for (const id of ids) {
		const text = buildAdaptedSystemPrompt("Read-only.", knownModelFamily({ provider: "test", id }));
		assert.match(text, /does not expand permissions/, id);
		assert.doesNotMatch(text, /takes precedence over|you may make local edits|show your step-by-step/i, id);
		assert.equal(text.match(/## Model-specific guidance/g)?.length, 1, id);
	}
});
