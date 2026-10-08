import assert from "node:assert/strict";
import test from "node:test";
import { knownModelFamily, type KnownModelFamily } from "../src/model-prompts/families.ts";

const recognized: [provider: string, id: string, family: KnownModelFamily][] = [
	["anthropic", "claude-opus-5-5", "claude-opus-5.5"],
	["anthropic", "claude-opus-5.5", "claude-opus-5.5"],
	["openrouter", "anthropic/claude-opus-5.5", "claude-opus-5.5"],
	["anthropic", "claude-sonnet-5-5", "claude-sonnet-5.5"],
	["anthropic", "claude-sonnet-5.5", "claude-sonnet-5.5"],
	["openrouter", "anthropic/claude-sonnet-5.5", "claude-sonnet-5.5"],
	["anthropic", "claude-fable-5-1", "claude-fable-5.1"],
	["anthropic", "claude-fable-5.1", "claude-fable-5.1"],
	["aperture", "neuralwatt/fable-5.1", "claude-fable-5.1"],
	["openrouter", "anthropic/claude-fable-5.1", "claude-fable-5.1"],
	["openai-codex", "gpt-6.1-sol", "gpt-6.1-sol"],
	["openrouter", "openai/gpt-6.1-sol", "gpt-6.1-sol"],
	["aperture", "openai/GPT-6.1-Sol", "gpt-6.1-sol"],
	["openai-codex", "gpt-6-astra", "gpt-6-astra"],
	["openrouter", "openai/gpt-6-astra", "gpt-6-astra"],
	["aperture", "openai/GPT-6-Astra", "gpt-6-astra"],
	["openai", "gpt-6-astra-20260901", "gpt-6-astra"],
	["neuralwatt", "glm-5.3", "glm-5.3"],
	["neuralwatt", "glm-5.3-flash", "glm-5.3"],
	["neuralwatt", "glm-5.3-flash-flex", "glm-5.3"],
	["synthetic", "hf:zai-org/GLM-5.3-Flash", "glm-5.3"],
	["neuralwatt", "kimi-k3", "kimi-k3"],
	["neuralwatt", "kimi-k3-fast", "kimi-k3"],
	["synthetic", "hf:moonshotai/Kimi-K3", "kimi-k3"],
	["aperture", "neuralwatt/kimi-k3", "kimi-k3"],
	["aperture", "neuralwatt/deepseek-v4.1-flash", "deepseek-v4.1"],
	["synthetic", "hf:deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-v4.1"],
	["openrouter", "deepseek/deepseek-v4.1", "deepseek-v4.1"],
];

// Other versions must not inherit a neighbouring version's guidance.
const unknown: [provider: string, id: string][] = [
	["anthropic", "claude-opus-4-5"],
	["anthropic", "claude-opus-4.5"],
	["anthropic", "claude-opus-4-5-20251101"],
	["anthropic", "claude-opus-5"],
	["anthropic", "claude-fable-5"],
	["anthropic", "claude-fable-5-10"],
	["aperture", "neuralwatt/fable-5.10"],
	["anthropic", "claude-sonnet-5"],
	["anthropic", "claude-sonnet-50"],
	["openai-codex", "gpt-5.6-sol"],
	["openai-codex", "gpt-6"],
	["openai-codex", "gpt-6-sol"],
	["openai-codex", "gpt-6-luna"],
	["openai", "gpt-6-astral"],
	["openai", "gpt-6.1-solar"],
	["openai", "gpt-6.1-astra"],
	["openai", "gpt-60"],
	["neuralwatt", "glm-5.2"],
	["neuralwatt", "kimi-k2.7-code"],
	["deepseek", "deepseek-v3"],
	["deepseek", "deepseek-v4-pro"],
	["deepseek", "deepseek-v4-flash"],
	["deepseek", "deepseek-v4.10"],
];

test("recognizes configured model families", () => {
	for (const [provider, id, family] of recognized) {
		assert.equal(knownModelFamily({ provider, id }), family, `${provider}/${id}`);
	}
});

test("returns undefined for other versions and similar names", () => {
	for (const [provider, id] of unknown) {
		assert.equal(knownModelFamily({ provider, id }), undefined, `${provider}/${id}`);
	}
});
