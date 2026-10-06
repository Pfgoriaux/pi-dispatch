/**
 * Durable pilot supervisor: runs admitted tasks as child Pi processes in
 * per-branch worktrees, integrates successful branches into one feature
 * branch, and publishes that branch as a draft pull request.
 *
 * - One spawn is one attempt. The attempt is committed as `running` (worker
 *   unknown) before its worktree or child exists; the child's identity is
 *   committed from `onSpawn`. A crash in between leaves `running` with no
 *   worker, which recovery blocks.
 * - The deadline timer belongs to this process, so a lost client cannot keep
 *   a child running. If this process dies, the child can outlive it; recovery
 *   then blocks on the live identity instead of retrying.
 * - Merges, pushes, and pull requests go through `runEffect` (reconcile.ts).
 *   The existing dispatch merge-back and merge agent are never used here.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types.ts";
import { runPilotProc, type PilotProcResult } from "../worker-proc.ts";
import { dirtyLines, removeWorktree } from "../worktree.ts";
import { attemptKey, putAttempt, type AttemptState, type WorkerIdentity } from "./contracts.ts";
import {
	applyMerge, applyPullRequest, applyPush, assertPublishTargets, branchSha, changedFiles, ensureTaskWorktree,
	isAncestor, observeMerge, observePullRequest, observePush, outsideOwnership, PROTECTED_BRANCHES,
	taskWorktreePath, withIntegrationLock, worktreeBranch,
	type MergeTarget, type PublishAllowlist, type PullRequestTarget, type PushTarget,
} from "./git.ts";
import { blockers, encodeTarget, reconcileEffects, runEffect, type EffectOutcome, type ReconcileReport } from "./reconcile.ts";
import { processStartIdentity, type DurableStore, type StoreSnapshot } from "./store.ts";

const exec = promisify(execFile);

export class SupervisorBlockedError extends Error {
	override name = "SupervisorBlockedError";
}

export interface PilotTask {
	/** Admitted task key. */
	readonly key: string;
	readonly prompt: string;
	readonly agent: AgentConfig;
	/** Exact `provider/id`; no fallback. */
	readonly model: string;
	readonly thinking: string;
	/** Files, or directories ending in `/`, the task may change. */
	readonly ownedPaths: readonly string[];
	/** Commands (argv, no shell) run in the task worktree after the worker succeeds. */
	readonly checks?: readonly (readonly string[])[];
}

export interface SupervisorOptions {
	readonly store: DurableStore;
	/** Checkout of `featureBranch`; tasks branch from its tip and merge back into it. */
	readonly featureRoot: string;
	readonly featureBranch: string;
	/** Absolute Pi executable for every child. */
	readonly piExecutable: string;
	readonly piPrefixArgs?: readonly string[];
	/** Central worktree folder, e.g. `~/eden/.worktrees`. */
	readonly worktreesRoot: string;
	/** Absolute directory for per-attempt child session directories. */
	readonly sessionsRoot: string;
	/** Task branches are `<branchPrefix>/<task>-a<attempt>`. */
	readonly branchPrefix: string;
	readonly allowlist: PublishAllowlist;
	/** Absolute `gh` executable; required to publish or reconcile pull requests. */
	readonly gh?: string;
	readonly registry?: ModelRegistry;
	readonly onWarning?: (warning: string) => void;
}

export interface RunLimits {
	/** Epoch milliseconds. Enforced by this process. */
	readonly deadlineAt: number;
	/** Optional client cancellation. Losing the client does not lift the deadline. */
	readonly signal?: AbortSignal;
}

export interface PublishRequest {
	readonly remote: string;
	readonly url: string;
	/** `owner/name` for gh. */
	readonly repo: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
}

type Outcome = Pick<AttemptState, "status" | "spentUsd" | "reason"> & { headSha?: string | null };

const MAX_TIMER_MS = 2 ** 31 - 1;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Pi session ID for one attempt: stable, valid for `--session-id`, distinct per batch. */
export function pilotSessionId(batchId: string, key: string): string {
	return `pd-${createHash("sha256").update(`${batchId}\0${key}`).digest("hex").slice(0, 24)}`;
}

/** Next attempt for `taskKey`, or the reason none may start. Pure; reads one snapshot. */
export function planAttempt(snapshot: StoreSnapshot, taskKey: string): { attempt: number; reserveUsd: number } {
	const { policy, attempts } = snapshot;
	if (!policy?.admitted) throw new SupervisorBlockedError("Batch is not admitted.");
	const task = policy.tasks.find((t) => t.key === taskKey);
	if (!task) throw new SupervisorBlockedError(`Task ${taskKey} is not admitted.`);
	const halted = blockers(snapshot);
	if (halted.length > 0) throw new SupervisorBlockedError(`Batch is halted: ${halted.join("; ")}`);
	const mine = attempts.filter((a) => a.taskKey === taskKey).sort((a, b) => a.attempt - b.attempt);
	const last = mine.at(-1);
	if (last && last.status !== "reserved" && last.status !== "failed") throw new SupervisorBlockedError(`${last.key} is ${last.status}.`);
	const attempt = !last ? 1 : last.status === "reserved" ? last.attempt : last.attempt + 1;
	if (attempt > policy.maxAttemptsPerTask) throw new SupervisorBlockedError(`${taskKey} used all ${policy.maxAttemptsPerTask} attempts.`);
	if (attempts.filter((a) => a.status === "running").length >= policy.maxWorkers) {
		throw new SupervisorBlockedError(`All ${policy.maxWorkers} workers are busy.`);
	}
	const committed = attempts.reduce((sum, a) => sum + (a.status === "reserved" || a.status === "running" ? a.reservedUsd : a.spentUsd ?? Infinity), 0);
	const extra = last?.status === "reserved" ? 0 : task.reserveUsd;
	if (committed + extra > policy.budgetUsd) throw new SupervisorBlockedError(`Attempt ${attempt} of ${taskKey} would exceed the budget.`);
	return { attempt, reserveUsd: task.reserveUsd };
}

/** True when the process or its process group may still run; unknown counts as running. */
async function mayStillRun(spawned: NonNullable<PilotProcResult["spawned"]>): Promise<boolean> {
	if (await processStartIdentity(spawned.pid) !== null) return true;
	try {
		process.kill(-spawned.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Spend is known only when the child never spawned or reported `agent_settled`. */
function spendOf(result: PilotProcResult): number | null {
	if (!result.launched) return 0;
	if (!result.settled || !result.spendKnown) return null;
	return result.usage?.cost.total ?? null;
}

export class Supervisor {
	#serial: Promise<unknown> = Promise.resolve();

	constructor(readonly options: SupervisorOptions) {
		if (process.platform === "win32") throw new SupervisorBlockedError("The durable pilot needs POSIX process groups.");
		const { featureBranch, branchPrefix, sessionsRoot, allowlist } = options;
		const protectedTarget = PROTECTED_BRANCHES.includes(featureBranch) || allowlist.bases.includes(featureBranch);
		if (protectedTarget) throw new SupervisorBlockedError(`Refusing protected feature branch ${featureBranch}.`);
		if (!branchPrefix || branchPrefix.split("/").some((part) => !SAFE_KEY.test(part))) {
			throw new SupervisorBlockedError(`Unsafe branch prefix ${JSON.stringify(branchPrefix)}.`);
		}
		if (!path.isAbsolute(sessionsRoot)) throw new SupervisorBlockedError("sessionsRoot must be absolute.");
	}

	#queue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#serial.catch(() => undefined).then(fn);
		this.#serial = run;
		return run;
	}

	/** Run one attempt of `task` to a terminal state. Throws only when no attempt was claimed or the store fails. */
	async runAttempt(task: PilotTask, limits: RunLimits): Promise<AttemptState> {
		if (!SAFE_KEY.test(task.key)) throw new SupervisorBlockedError(`Unsafe task key ${JSON.stringify(task.key)}.`);
		const remaining = limits.deadlineAt - Date.now();
		if (!(remaining > 0 && remaining <= MAX_TIMER_MS)) throw new SupervisorBlockedError("Deadline must be in the future and within 24 days.");
		if (limits.signal?.aborted) throw new SupervisorBlockedError("Cancelled before start.");
		const attempt = await this.#queue(() => this.#claim(task));
		let spawned = false;
		try {
			return await this.#execute(task, attempt, limits, () => { spawned = true; });
		} catch (error) {
			await this.#finish(attempt, { status: "blocked", spentUsd: spawned ? null : 0, reason: message(error) }).catch(() => undefined);
			throw error;
		}
	}

	async #claim(task: PilotTask): Promise<AttemptState> {
		const { store, featureRoot, featureBranch, worktreesRoot, branchPrefix } = this.options;
		const plan = planAttempt(await store.read(), task.key);
		const baseSha = await branchSha(featureRoot, featureBranch);
		if (!baseSha) throw new SupervisorBlockedError(`Feature branch ${featureBranch} is missing.`);
		const branch = `${branchPrefix}/${task.key}-a${plan.attempt}`;
		const attempt: AttemptState = {
			key: attemptKey(task.key, plan.attempt), taskKey: task.key, attempt: plan.attempt, status: "running",
			reservedUsd: plan.reserveUsd, spentUsd: 0, worker: null, worktree: await taskWorktreePath(worktreesRoot, featureRoot, branch),
			branch, baseSha, headSha: null, pr: null, reason: null,
		};
		await store.harness.commit((tx) => putAttempt(store.contracts, tx, attempt), store.context);
		return attempt;
	}

	async #execute(task: PilotTask, attempt: AttemptState, limits: RunLimits, markSpawned: () => void): Promise<AttemptState> {
		const controller = new AbortController();
		let stopped: string | undefined;
		const stop = (why: string) => { stopped ??= why; controller.abort(); };
		const timer = setTimeout(() => stop("deadline exceeded"), limits.deadlineAt - Date.now());
		const cancel = () => stop("cancelled");
		limits.signal?.addEventListener("abort", cancel, { once: true });
		try {
			await ensureTaskWorktree(this.options.featureRoot, attempt.worktree!, attempt.branch!, attempt.baseSha!);
			const sessionId = pilotSessionId(this.options.store.identity.batchId, attempt.key);
			const sessionDir = this.#claimSessionDir(sessionId);
			const result = await runPilotProc(task.agent, task.prompt, {
				cwd: attempt.worktree!, piExecutable: this.options.piExecutable, piPrefixArgs: this.options.piPrefixArgs,
				model: task.model, thinking: task.thinking, sessionId, sessionDir, signal: controller.signal,
				requireCleanWorktree: true, registry: this.options.registry, onWarning: this.options.onWarning,
				onSpawn: async (pid, startedAt) => {
					markSpawned();
					await this.#recordWorker(attempt, { pid, startedAt, host: os.hostname() });
				},
			});
			if (result.launched) markSpawned();
			const outcome = await this.#judge(task, attempt, result, controller.signal, stopped);
			return await this.#finish(attempt, outcome);
		} finally {
			clearTimeout(timer);
			limits.signal?.removeEventListener("abort", cancel);
		}
	}

	/** An existing session directory proves an earlier spawn of this attempt. */
	#claimSessionDir(sessionId: string): string {
		fs.mkdirSync(this.options.sessionsRoot, { recursive: true });
		const dir = path.join(this.options.sessionsRoot, sessionId);
		try {
			fs.mkdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SupervisorBlockedError(`Session ${sessionId} already exists; refusing a second spawn.`);
			throw error;
		}
		return dir;
	}

	async #recordWorker(attempt: AttemptState, worker: WorkerIdentity): Promise<void> {
		const { store } = this.options;
		await store.harness.commit(async (tx) => {
			const draft = await tx.doc(store.contracts.AttemptDoc, attempt.key, attempt);
			if (draft.status !== "running" || draft.worker) throw new Error(`${attempt.key} cannot take a second worker.`);
			draft.worker = worker;
		}, store.context);
	}

	async #judge(task: PilotTask, attempt: AttemptState, result: PilotProcResult, signal: AbortSignal, stopped?: string): Promise<Outcome> {
		const spentUsd = spendOf(result);
		if (result.spawned && await mayStillRun(result.spawned)) {
			return { status: "blocked", spentUsd: null, reason: `worker ${result.spawned.pid} or its process group is still running` };
		}
		if (result.launched && !result.spawned) {
			return { status: "blocked", spentUsd: null, reason: result.error ?? "worker identity was never recorded" };
		}
		if (result.status !== "ok") return { status: "failed", spentUsd, reason: stopped ?? result.error ?? result.status };
		const problem = await this.#verifyBranch(task, attempt, signal).catch(message);
		if (typeof problem === "string") return { status: "failed", spentUsd, reason: problem };
		return { status: "succeeded", spentUsd, reason: null, headSha: problem.head };
	}

	/** Branch still checked out, descends from base, stays in owned paths, and passes checks. */
	async #verifyBranch(task: PilotTask, attempt: AttemptState, signal: AbortSignal): Promise<string | { head: string }> {
		const cwd = attempt.worktree!;
		if (await worktreeBranch(cwd) !== attempt.branch) return `worktree is no longer on ${attempt.branch}`;
		const head = await branchSha(cwd, attempt.branch!);
		if (!head || !(await isAncestor(cwd, attempt.baseSha!, head))) return `${attempt.branch} does not descend from ${attempt.baseSha}`;
		const outside = outsideOwnership(await changedFiles(cwd, attempt.baseSha!, head), task.ownedPaths);
		if (outside.length > 0) return `changes outside owned paths: ${outside.slice(0, 5).join(", ")}`;
		for (const argv of task.checks ?? []) {
			const failed = await exec(argv[0], argv.slice(1), { cwd, signal, maxBuffer: 16 * 1024 * 1024 }).then(() => false, () => true);
			if (failed) return `check failed: ${argv.join(" ")}`;
		}
		if (await worktreeBranch(cwd) !== attempt.branch) return "check changed the worktree branch";
		if (await branchSha(cwd, attempt.branch!) !== head) return "check changed the committed SHA";
		if ((await dirtyLines(cwd, false)).length > 0) return "check mutated the worktree";
		return { head };
	}

	async #finish(attempt: AttemptState, outcome: Outcome): Promise<AttemptState> {
		const { store } = this.options;
		await store.harness.commit(async (tx) => {
			Object.assign(await tx.doc(store.contracts.AttemptDoc, attempt.key, attempt), outcome);
		}, store.context);
		const stored = await store.harness.snapshot(store.contracts.AttemptDoc, attempt.key, store.context);
		if (!stored) throw new Error(`${attempt.key} disappeared from the store.`);
		return structuredClone(stored) as AttemptState;
	}

	/** Merge a succeeded attempt's recorded head into the feature branch, serialized per checkout. */
	async integrate(key: string): Promise<EffectOutcome> {
		const { store, featureRoot, featureBranch } = this.options;
		const effectKey = `${key}:merge`;
		const snapshot = await store.read();
		const attempt = snapshot.attempts.find((a) => a.key === key);
		if (attempt?.status !== "succeeded" || !attempt.headSha || !attempt.branch) {
			throw new SupervisorBlockedError(`${key} has no succeeded head to integrate.`);
		}
		const halted = blockers(snapshot, new Set([effectKey]));
		if (halted.length > 0) throw new SupervisorBlockedError(`Batch is halted: ${halted.join("; ")}`);
		const target: MergeTarget = { featureRoot, branch: featureBranch };
		const { headSha: sha, branch } = attempt;
		const outcome = await withIntegrationLock(featureRoot, () => runEffect(store, {
			key: effectKey, attemptKey: key, kind: "merge", status: "intended", target: encodeTarget(target), sha, pr: null,
		}, {
			observe: () => observeMerge(target, sha),
			apply: async () => {
				const current = await branchSha(featureRoot, branch);
				if (current !== sha) throw new SupervisorBlockedError(`${branch} moved from ${sha} to ${current}.`);
				await applyMerge(target, sha, `Merge ${branch} (${key})`);
			},
		}));
		// Clean worktrees go; dirty or locked ones stay for recovery. The branch stays as evidence.
		if (outcome.status === "applied" && attempt.worktree) await removeWorktree(featureRoot, attempt.worktree, { deleteBranch: false });
		return outcome;
	}

	/** Push the feature tip to an allowlisted remote, then open one draft pull request for it. */
	async publish(request: PublishRequest): Promise<{ push: EffectOutcome; pullRequest?: EffectOutcome }> {
		const { store, featureRoot, featureBranch, allowlist, gh } = this.options;
		const push: PushTarget = { repoRoot: featureRoot, remote: request.remote, url: request.url, branch: featureBranch };
		const pr: PullRequestTarget = { repo: request.repo, base: request.base, head: featureBranch };
		await assertPublishTargets(allowlist, push, pr);
		if (!gh || !path.isAbsolute(gh)) throw new SupervisorBlockedError("Publishing needs an absolute gh executable.");
		const sha = await branchSha(featureRoot, featureBranch);
		if (!sha) throw new SupervisorBlockedError(`Feature branch ${featureBranch} is missing.`);
		const scope = `feature:${featureBranch}`;
		const keys = { push: `${scope}:push:${request.remote}:${sha}`, pr: `${scope}:pull-request:${request.repo}:${request.base}:${sha}` };
		const halted = blockers(await store.read(), new Set(Object.values(keys)));
		if (halted.length > 0) throw new SupervisorBlockedError(`Batch is halted: ${halted.join("; ")}`);
		const pushed = await runEffect(store, {
			key: keys.push, attemptKey: scope, kind: "push", status: "intended", target: encodeTarget(push), sha, pr: null,
		}, { observe: () => observePush(push, sha), apply: () => applyPush(push, sha) });
		if (pushed.status !== "applied") return { push: pushed };
		const pullRequest = await runEffect(store, {
			key: keys.pr, attemptKey: scope, kind: "pull-request", status: "intended", target: encodeTarget(pr), sha, pr: null,
		}, {
			observe: () => observePullRequest(gh, pr, sha),
			apply: () => applyPullRequest(gh, pr, request.title, request.body),
		});
		return { push: pushed, pullRequest };
	}

	/** Settle effects a previous owner left unresolved; see `reconcileEffects`. */
	reconcile(): Promise<ReconcileReport> {
		return reconcileEffects(this.options.store, { gh: this.options.gh });
	}
}
