import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveChildModel } from "../src/child-model.ts";

const models = [{ provider: "unauthenticated", id: "shared" }, { provider: "authenticated", id: "shared" }];
function registry(available = models): ModelRegistry {
	return {
		getAll: () => models, getAvailable: () => available,
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
	} as ModelRegistry;
}

test("bare child ID selects the unique authenticated provider, not catalog order", () => {
	assert.equal(resolveChildModel(registry([models[1]]), "shared"), models[1]);
});

test("ambiguous child IDs require an explicit provider", () => {
	assert.equal(resolveChildModel(registry(), "shared"), undefined);
	assert.equal(resolveChildModel(registry([]), "shared"), undefined);
	assert.equal(resolveChildModel(registry(), "authenticated/shared"), models[1]);
});

test("child refuses literal IDs that collide with shorter CLI canonical references", () => {
	const catalog = [{ provider: "p", id: "p/foo" }, { provider: "p", id: "foo" }];
	const collision = { find: (provider: string, id: string) => catalog.find(model => model.provider === provider && model.id === id) } as ModelRegistry;
	assert.equal(resolveChildModel(collision, "p/p/foo"), undefined);
	assert.equal(resolveChildModel(collision, "p/foo"), catalog[1]);
});
