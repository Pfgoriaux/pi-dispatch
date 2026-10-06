/**
 * Reconcile-first effect phases. An effect's intent is committed before it
 * runs; every run, including the first, observes the world before applying,
 * and only an observation marks it applied. This makes retries idempotent for
 * the identities checked here. It does not make external effects exactly-once:
 * anything not proven stays `unresolved` and halts automatic work.
 */

import fs from "node:fs";
import os from "node:os";
import { putEffect, type AttemptState, type EffectState } from "./contracts.ts";
import {
	branchSha, observeMerge, observePullRequest, observePush,
	type MergeTarget, type Observation, type PullRequestTarget, type PushTarget,
} from "./git.ts";
import { processStartIdentity, type DurableStore, type StoreSnapshot } from "./store.ts";
import { dirtyLines } from "../worktree.ts";

export type EffectOutcome =
	| { readonly status: "applied"; readonly effect: Readonly<EffectState> }
	| { readonly status: "blocked"; readonly effect: Readonly<EffectState>; readonly reason: string };

export interface EffectOps {
	readonly observe: () => Promise<Observation>;
	readonly apply: () => Promise<void>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Reasons the batch must not continue automatically. `allow` exempts effects the caller is about to reconcile. */
export function blockers(snapshot: StoreSnapshot, allow: ReadonlySet<string> = new Set()): string[] {
	const attempts = snapshot.attempts.flatMap((a) => [
		...(a.status === "blocked" || a.status === "interrupted" ? [`${a.key} is ${a.status}${a.reason ? `: ${a.reason}` : ""}`] : []),
		...(a.spentUsd === null ? [`${a.key} has unknown spend`] : []),
	]);
	const effects = snapshot.effects
		.filter((e) => e.status === "unresolved" && !allow.has(e.key))
		.map((e) => `${e.key} is unresolved`);
	return [...attempts, ...effects];
}

async function safeObserve(observe: () => Promise<Observation>): Promise<Observation> {
	try { return await observe(); } catch (error) { return { state: "blocked", reason: message(error) }; }
}

async function settle(store: DurableStore, effect: Readonly<EffectState>, seen: Observation): Promise<EffectOutcome> {
	const applied = seen.state === "applied";
	const next: EffectState = { ...effect, status: applied ? "applied" : "unresolved", pr: applied ? seen.pr ?? effect.pr : effect.pr };
	await store.harness.commit(async (tx) => {
		const draft = await tx.doc(store.contracts.EffectDoc, effect.key, effect);
		Object.assign(draft, next);
	}, store.context);
	if (applied) return { status: "applied", effect: next };
	return { status: "blocked", effect: next, reason: seen.state === "blocked" ? seen.reason : "effect is not visible" };
}

/**
 * Commit intent (once per key), observe, apply only when provably absent, then
 * observe again. A record with the same key but another target or SHA blocks.
 */
export async function runEffect(store: DurableStore, intent: EffectState, ops: EffectOps): Promise<EffectOutcome> {
	const existing = (await store.read()).effects.find((e) => e.key === intent.key);
	const same = existing && existing.kind === intent.kind && existing.target === intent.target && existing.sha === intent.sha;
	if (existing && !same) return { status: "blocked", effect: existing, reason: `${intent.key} was recorded for another target` };
	if (existing?.status === "applied") return { status: "applied", effect: existing };
	const effect: EffectState = existing ? { ...existing } : { ...intent, status: "intended" };
	if (!existing) await store.harness.commit((tx) => putEffect(store.contracts, tx, effect), store.context);
	let seen = await safeObserve(ops.observe);
	if (seen.state !== "absent") return settle(store, effect, seen);
	const failure = await ops.apply().then(() => undefined, message);
	seen = await safeObserve(ops.observe);
	if (seen.state === "absent") seen = { state: "blocked", reason: failure ?? "effect is not visible after applying" };
	return settle(store, effect, seen);
}

export const encodeTarget = (target: MergeTarget | PushTarget | PullRequestTarget): string => JSON.stringify(target);

function decodeTarget<T>(effect: Readonly<EffectState>, keys: readonly (keyof T & string)[]): T {
	const parsed = JSON.parse(effect.target) as Record<string, unknown>;
	if (keys.some((key) => typeof parsed?.[key] !== "string")) throw new Error(`${effect.key} has an unreadable target`);
	return parsed as T;
}

export interface ReconcileAdapters {
	/** Absolute `gh` executable for pull-request observation. */
	readonly gh?: string;
}

/** Read-only observation of one recorded effect. */
export async function observeEffect(effect: Readonly<EffectState>, adapters: ReconcileAdapters): Promise<Observation> {
	const sha = effect.sha;
	if (!sha) return { state: "blocked", reason: `${effect.key} has no recorded SHA` };
	return safeObserve(async () => {
		if (effect.kind === "merge") return observeMerge(decodeTarget<MergeTarget>(effect, ["featureRoot", "branch"]), sha);
		if (effect.kind === "push") return observePush(decodeTarget<PushTarget>(effect, ["repoRoot", "remote", "url", "branch"]), sha);
		if (effect.kind === "pull-request" && adapters.gh) {
			return observePullRequest(adapters.gh, decodeTarget<PullRequestTarget>(effect, ["repo", "base", "head"]), sha);
		}
		return { state: "blocked", reason: `No observer for ${effect.kind}` };
	});
}

export interface AttemptInspection {
	readonly key: string;
	readonly status: AttemptState["status"];
	readonly worker: "alive" | "dead" | "unknown" | "none";
	readonly branchSha: string | null;
	readonly worktree: "missing" | "clean" | "dirty" | "unknown";
}

async function inspectAttempt(attempt: Readonly<AttemptState>): Promise<AttemptInspection> {
	const identity = attempt.worker && attempt.worker.host === os.hostname() ? await processStartIdentity(attempt.worker.pid) : undefined;
	const worker = !attempt.worker ? "none" : identity === undefined ? "unknown" : identity === attempt.worker.startedAt ? "alive" : "dead";
	const present = !!attempt.worktree && fs.existsSync(attempt.worktree);
	const dirt = present ? await dirtyLines(attempt.worktree!, false).catch(() => undefined) : undefined;
	const worktree = !present ? "missing" : dirt === undefined ? "unknown" : dirt.length > 0 ? "dirty" : "clean";
	const sha = present && attempt.branch ? await branchSha(attempt.worktree!, attempt.branch) : null;
	return { key: attempt.key, status: attempt.status, worker, branchSha: sha, worktree };
}

export interface ReconcileReport {
	readonly applied: readonly string[];
	readonly unresolved: readonly { key: string; state: "absent" | "blocked"; reason: string }[];
	/** Halting attempts, for a human; never changed here. */
	readonly attempts: readonly AttemptInspection[];
	readonly halted: boolean;
}

/**
 * Settle effects left `unresolved` by a previous owner: mark the ones the world
 * proves applied, report the rest. Attempts are inspected, never retried or
 * changed. Refuses while this store has running attempts or in-flight effects.
 */
export async function reconcileEffects(store: DurableStore, adapters: ReconcileAdapters = {}): Promise<ReconcileReport> {
	const before = await store.read();
	if (before.attempts.some((a) => a.status === "running") || before.effects.some((e) => e.status === "intended")) {
		throw new Error("Reconcile only while no attempt or effect is in flight.");
	}
	const applied: string[] = [];
	const unresolved: { key: string; state: "absent" | "blocked"; reason: string }[] = [];
	for (const effect of before.effects.filter((e) => e.status === "unresolved")) {
		const seen = await observeEffect(effect, adapters);
		if (seen.state === "applied") {
			await settle(store, effect, seen);
			applied.push(effect.key);
			continue;
		}
		unresolved.push({ key: effect.key, state: seen.state, reason: seen.state === "blocked" ? seen.reason : "not applied; rerun its phase to apply" });
	}
	const halting = before.attempts.filter((a) => a.status === "blocked" || a.status === "interrupted" || a.spentUsd === null);
	const attempts = await Promise.all(halting.map(inspectAttempt));
	const recovery = await store.recover();
	return { applied, unresolved, attempts, halted: recovery.halted };
}
