/**
 * Durable pilot supervisor: runs admitted tasks as child Pi processes in
 * retained per-branch worktrees and publishes verified branches as draft PRs.
 *
 * - One spawn is one attempt. The attempt is committed as `running` (worker
 *   unknown) before its worktree or child exists; the child's identity is
 *   committed from `onSpawn`. A crash in between leaves `running` with no
 *   worker, which recovery blocks.
 * - The deadline timer belongs to this process, so a lost client cannot keep
 *   a child running. If this process dies, the child keeps running (its
 *   stdout is a file). `adopt` waits for it, never respawns it, and judges it
 *   from its session evidence (evidence.ts).
 * - `review` records each read-only try before spawning. A completed review
 *   is never repeated; at most two failed tries are allowed for a head.
 * - Pushes and pull requests go through `runEffect` (reconcile.ts).
 *   Target branches are never merged or removed.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types.ts";
import { correctnessSecurityTask } from "../tools/pr-review-prompts.ts";
import { runPilotProc, type PilotProcResult } from "../worker-proc.ts";
import { dirtyLines, gitThrow } from "../worktree.ts";
import {
	attemptKey, committedUsd, putAttempt, reviewFailures, reviewRetryable, runningWorkers,
	type AttemptState, type ReviewState, type WorkerIdentity,
} from "./contracts.ts";
import { readEvidence, reportedEvidenceUsd } from "./evidence.ts";
import {
	applyPullRequest, applyPush, assertPublishTargets, branchSha, changedFiles, ensureTaskWorktree,
	isAncestor, observePullRequest, observePush, outsideOwnership, PROTECTED_BRANCHES,
	taskWorktreePath, worktreeBranch,
	type PublishAllowlist, type PullRequestTarget, type PushTarget,
} from "./git.ts";
import { blockers, encodeTarget, reconcileEffects, runEffect, type EffectOutcome, type ReconcileReport } from "./reconcile.ts";
import { processStartIdentity, type DurableStore, type StoreSnapshot } from "./store.ts";

const exec = promisify(execFile);

export class SupervisorBlockedError extends Error {
	override name = "SupervisorBlockedError";
}

export class AttemptNotStartedError extends Error {}

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
	/** Repository containing `featureBranch`; tasks branch from its tip. */
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
	/** Bound on one review try, from its start; defaults to `REVIEW_TIME_LIMIT_MS`. */
	readonly reviewTimeLimitMs?: number;
	readonly onWarning?: (warning: string) => void;
}

export interface RunLimits {
	/** Epoch milliseconds. Enforced by this process. */
	readonly deadlineAt: number;
	/** Optional client cancellation. Losing the client does not lift the deadline. */
	readonly signal?: AbortSignal;
	/** Rechecked immediately before admission, after asynchronous preparation. */
	readonly canStart?: () => boolean;
	/** Stop reason when `deadlineAt` passes; defaults to "deadline exceeded". */
	readonly expiry?: string;
	/** Persist review cancellation before signalling its child. */
	readonly onStop?: (reason: string) => Promise<void>;
}

/** Default bound on one review try; real reviews take minutes, a runaway one would hold its slot until the deadline. */
export const REVIEW_TIME_LIMIT_MS = 20 * 60_000;

export interface PublishRequest {
	/** Exact commit whose checks passed. Never replace it with the current tip. */
	readonly headSha: string;
	readonly remote: string;
	readonly url: string;
	/** `owner/name` for gh. */
	readonly repo: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
}

export interface ReviewRequest {
	/** Read-only reviewer: no edit, write, or shell tools. */
	readonly agent: AgentConfig;
	readonly model: string;
	readonly thinking: string;
	/** The task description, given to the reviewer as intent. */
	readonly intent: string;
	/** Start of the reviewed diff: the task's verified base. */
	readonly baseSha: string;
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
	const open = !last || last.status === "reserved" || last.status === "failed" || needsFix(last);
	if (!open) throw new SupervisorBlockedError(`${last.key} is ${last.status}.`);
	const attempt = !last ? 1 : last.status === "reserved" ? last.attempt : last.attempt + 1;
	if (attempt > policy.maxAttemptsPerTask) throw new SupervisorBlockedError(`${taskKey} used all ${policy.maxAttemptsPerTask} attempts.`);
	if (runningWorkers(attempts) >= policy.maxWorkers) throw new SupervisorBlockedError(`All ${policy.maxWorkers} workers are busy.`);
	const extra = last?.status === "reserved" ? 0 : task.reserveUsd;
	if (committedUsd(attempts) + extra > policy.budgetUsd) throw new SupervisorBlockedError(`Attempt ${attempt} of ${taskKey} would exceed the budget.`);
	return { attempt, reserveUsd: task.reserveUsd };
}

/** A succeeded attempt whose finished review of its head found validated blocking findings. */
export function needsFix(attempt: Readonly<AttemptState>): boolean {
	const review = attempt.review;
	return attempt.status === "succeeded" && review?.status === "done" && review.headSha === attempt.headSha && review.blocking > 0;
}

/**
 * Reserve for a review of `key`'s head, or the reason it is skipped. Throws
 * when the batch is halted or every worker is busy.
 */
export function planReview(snapshot: StoreSnapshot, key: string, deadlineAt: number): { reserveUsd: number } | { skip: string } {
	const { policy, attempts } = snapshot;
	const halted = blockers(snapshot);
	if (halted.length > 0) throw new SupervisorBlockedError(`Batch is halted: ${halted.join("; ")}`);
	if (runningWorkers(attempts) >= (policy?.maxWorkers ?? 0)) throw new SupervisorBlockedError("All workers are busy.");
	const attempt = attempts.find((a) => a.key === key);
	const reserveUsd = policy?.tasks.find((t) => t.key === attempt?.taskKey)?.reserveUsd;
	if (attempt?.status !== "succeeded" || reserveUsd === undefined) throw new SupervisorBlockedError(`${key} is not a succeeded attempt.`);
	if (Date.now() >= deadlineAt) return { skip: "deadline passed before review" };
	if (committedUsd(attempts) + reserveUsd > policy!.budgetUsd) return { skip: "review would exceed the budget" };
	return { reserveUsd };
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

const POLL_MS = 500;
const GRACE_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signal a worker's process group, and its leader only right after its start identity matched. */
function signalWorker(pid: number, signal: NodeJS.Signals, leader: boolean): void {
	try { process.kill(-pid, signal); } catch { /* group gone */ }
	if (!leader) return;
	try { process.kill(pid, signal); } catch { /* process gone */ }
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

const UNKNOWN_READS = 3;

/**
 * Wait until a previous owner's worker and its process group exit. At the
 * deadline or on cancellation, send SIGTERM, then SIGKILL after a grace
 * period; a group that outlives three grace periods blocks. The leader PID is
 * signalled only right after its identity matched; the group ID is used while
 * the group still has members.
 */
export async function awaitExit(worker: WorkerIdentity, limits: RunLimits): Promise<{ stopped: string | null } | { blocked: string }> {
	let stopped: string | null = null;
	let signalledAt = 0;
	let unknown = 0;
	for (;;) {
		const identity = await processStartIdentity(worker.pid);
		unknown = identity === undefined ? unknown + 1 : 0;
		if (unknown >= UNKNOWN_READS) return { blocked: `cannot read the identity of worker ${worker.pid}` };
		const leader = identity === worker.startedAt;
		if (identity !== undefined && !leader && !groupAlive(worker.pid)) return { stopped };
		const why = limits.signal?.aborted ? "cancelled" : Date.now() >= limits.deadlineAt ? limits.expiry ?? "deadline exceeded" : null;
		const waited = Date.now() - signalledAt;
		if (why && !stopped) {
			await limits.onStop?.(why);
			stopped = why;
			signalledAt = Date.now();
			signalWorker(worker.pid, "SIGTERM", leader);
		} else if (stopped && waited > 3 * GRACE_MS) {
			return { blocked: `worker ${worker.pid}'s process group survived SIGKILL` };
		} else if (stopped && waited > GRACE_MS) {
			signalWorker(worker.pid, "SIGKILL", leader);
		}
		await sleep(POLL_MS);
	}
}

/** Abort signal for checks: the caller's cancellation or the deadline, whichever comes first. */
const checkSignal = (limits: RunLimits) => AbortSignal.any([
	...(limits.signal ? [limits.signal] : []), AbortSignal.timeout(Math.max(0, limits.deadlineAt - Date.now())),
]);

const REVIEW_RULES = [
	"",
	"Before answering, check every finding against the code at this commit and report only findings you confirmed.",
	"Use [blocker] only for a defect that must be fixed before merge, and cite a file the diff changes.",
	"If nothing qualifies, answer exactly: No findings.",
];

/** Count findings in the shared pr_review format. A blocker counts only when it cites a changed file. */
export function parseReview(text: string, changed: readonly string[]): Pick<ReviewState, "blocking" | "other" | "findings"> {
	const sections = text.split(/^(?=## \[(?:blocker|major|minor)\])/m).filter((s) => /^## \[/.test(s));
	const cited = (section: string) => /^- File:\s*`?([^\s`:]+)/m.exec(section)?.[1];
	const blocking = sections.filter((s) => s.startsWith("## [blocker]") && changed.includes(cited(s) ?? "")).length;
	return { blocking, other: sections.length - blocking, findings: sections.length > 0 ? Array.from(text.trim()).slice(0, 6000).join("") : null };
}

/** Session run name of a review try: `<key>/review`, then `<key>/review-<n>` for retries. */
const reviewRun = (key: string, review: Readonly<ReviewState>) =>
	(review.tries ?? 1) === 1 ? `${key}/review` : `${key}/review-${review.tries}`;

/** A finished child: settled with its answer, or a terminal outcome. */
type Ran =
	| { status: "settled"; spentUsd: number | null; text: string }
	| { status: "blocked" | "failed"; spentUsd: number | null; reason: string; stopped?: boolean; reportedUsd?: number };

async function judgeRun(result: PilotProcResult, stopped?: string): Promise<Ran> {
	const spentUsd = spendOf(result);
	if (result.spawned && await mayStillRun(result.spawned)) {
		return { status: "blocked", spentUsd: null, reason: `worker ${result.spawned.pid} or its process group is still running` };
	}
	if (result.launched && !result.spawned) return { status: "blocked", spentUsd: null, reason: result.error ?? "worker identity was never recorded" };
	if (result.status !== "ok") {
		const reported = result.usage?.cost.total ?? 0;
		return {
			status: "failed", spentUsd, reason: stopped ?? result.error ?? result.status, stopped: !!stopped,
			reportedUsd: Number.isFinite(reported) && reported > 0 ? reported : 0,
		};
	}
	return { status: "settled", spentUsd, text: result.text };
}

/** Judge a previous owner's child once it exits, from its session evidence only. */
async function judgeOrphan(worker: WorkerIdentity, dir: string, sessionId: string, limits: RunLimits, review?: Readonly<ReviewState>): Promise<Ran> {
	const exit = await awaitExit(worker, limits);
	if ("blocked" in exit) return { status: "blocked", spentUsd: null, reason: exit.blocked };
	const stopped = exit.stopped ?? review?.stopReason;
	if (review && stopped) {
		return { status: "failed", spentUsd: null, reason: stopped, stopped: true, reportedUsd: reportedEvidenceUsd(dir, sessionId) };
	}
	const evidence = readEvidence(dir, sessionId);
	if (evidence.state === "ambiguous") return { status: "blocked", spentUsd: null, reason: evidence.reason };
	if (evidence.state === "unsettled") return { status: "failed", spentUsd: null, reason: exit.stopped ?? "worker exited before it settled" };
	if (evidence.problem) return { status: "failed", spentUsd: evidence.spentUsd, reason: evidence.problem };
	return { status: "settled", spentUsd: evidence.spentUsd, text: evidence.text };
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
		const attempt = await this.#queue(() => this.#claim(task, limits));
		let spawned = false;
		try {
			return await this.#execute(task, attempt, limits, () => { spawned = true; });
		} catch (error) {
			await this.#finish(attempt, { status: "blocked", spentUsd: spawned ? null : 0, reason: message(error) }).catch(() => undefined);
			throw error;
		}
	}

	async #claim(task: PilotTask, limits: RunLimits): Promise<AttemptState> {
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
		await store.harness.commit((tx) => {
			if (limits.signal?.aborted || limits.canStart?.() === false) throw new AttemptNotStartedError("Stopped before admission.");
			if (Date.now() >= limits.deadlineAt) throw new AttemptNotStartedError("Deadline passed before admission.");
			return putAttempt(store.contracts, tx, attempt);
		}, store.context);
		return attempt;
	}

	/** Run `fn` with a signal that aborts at the deadline or on cancellation; `stopped` names which. */
	async #bounded<T>(limits: RunLimits, fn: (signal: AbortSignal, stopped: () => string | undefined) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		let stopped: string | undefined;
		let stopping: Promise<void> | undefined;
		const stop = (why: string) => {
			if (stopping) return;
			stopped = why;
			stopping = Promise.resolve().then(() => limits.onStop?.(why)).finally(() => controller.abort());
			stopping.catch(() => undefined);
		};
		const timer = setTimeout(() => stop(limits.expiry ?? "deadline exceeded"), limits.deadlineAt - Date.now());
		const cancel = () => stop("cancelled");
		limits.signal?.addEventListener("abort", cancel, { once: true });
		if (limits.signal?.aborted) cancel();
		try {
			return await fn(controller.signal, () => stopped);
		} finally {
			clearTimeout(timer);
			limits.signal?.removeEventListener("abort", cancel);
			await stopping;
		}
	}

	/** Session ID and directory of one run: an attempt key, or `<attempt key>/review`. */
	#session(run: string): { sessionId: string; dir: string } {
		const sessionId = pilotSessionId(this.options.store.identity.batchId, run);
		return { sessionId, dir: path.join(this.options.sessionsRoot, sessionId) };
	}

	/** Spawn options shared by workers and reviewers; `onSpawn` records the identity first. */
	#spawn(run: string, cwd: string, signal: AbortSignal, onSpawn: (worker: WorkerIdentity) => Promise<void>) {
		const { sessionId } = this.#session(run);
		return {
			cwd, piExecutable: this.options.piExecutable, piPrefixArgs: this.options.piPrefixArgs, sessionId,
			sessionDir: this.#claimSessionDir(sessionId), signal, registry: this.options.registry, onWarning: this.options.onWarning,
			onSpawn: (pid: number, startedAt: string) => onSpawn({ pid, startedAt, host: os.hostname() }),
		};
	}

	async #execute(task: PilotTask, attempt: AttemptState, limits: RunLimits, markSpawned: () => void): Promise<AttemptState> {
		return this.#bounded(limits, async (signal, stopped) => {
			await ensureTaskWorktree(this.options.featureRoot, attempt.worktree!, attempt.branch!, attempt.baseSha!);
			const result = await runPilotProc(task.agent, task.prompt, {
				...this.#spawn(attempt.key, attempt.worktree!, signal, async (worker) => {
					markSpawned();
					await this.#recordWorker(attempt, worker);
				}),
				model: task.model, thinking: task.thinking, requireCleanWorktree: true,
			});
			if (result.launched) markSpawned();
			const outcome = await this.#judge(task, attempt, result, signal, stopped());
			return await this.#finish(attempt, outcome);
		});
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
		const ran = await judgeRun(result, stopped);
		if (ran.status !== "settled") return ran;
		return this.#verified(task, attempt, ran.spentUsd, signal);
	}

	async #verified(task: PilotTask, attempt: AttemptState, spentUsd: number | null, signal: AbortSignal): Promise<Outcome> {
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
		if (head === attempt.baseSha) return "worker produced no commit";
		const files = await changedFiles(cwd, attempt.baseSha!, head);
		if (files.length === 0) return "worker produced no file changes";
		const outside = outsideOwnership(files, task.ownedPaths);
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
		return this.#stored(attempt.key);
	}

	async #stored(key: string): Promise<AttemptState> {
		const { store } = this.options;
		const stored = await store.harness.snapshot(store.contracts.AttemptDoc, key, store.context);
		if (!stored) throw new Error(`${key} disappeared from the store.`);
		return structuredClone(stored) as AttemptState;
	}

	/** Finish a running attempt a previous owner started: wait for its worker, then judge it. Never spawns. */
	async adopt(task: PilotTask, key: string, limits: RunLimits): Promise<AttemptState> {
		const attempt = await this.#stored(key);
		if (attempt.status !== "running" || !attempt.worker) throw new SupervisorBlockedError(`${key} has no recorded worker to adopt.`);
		const outcome = await this.#judgeAdopted(task, attempt, limits).catch((error): Outcome => ({ status: "blocked", spentUsd: null, reason: message(error) }));
		return this.#finish(attempt, outcome);
	}

	async #judgeAdopted(task: PilotTask, attempt: AttemptState, limits: RunLimits): Promise<Outcome> {
		const { sessionId, dir } = this.#session(attempt.key);
		const ran = await judgeOrphan(attempt.worker!, dir, sessionId, limits);
		if (ran.status !== "settled") return ran;
		if ((await dirtyLines(attempt.worktree!, false)).length > 0) {
			return { status: "failed", spentUsd: ran.spentUsd, reason: `Worker left uncommitted edits; worktree retained at ${attempt.worktree}` };
		}
		return this.#verified(task, attempt, ran.spentUsd, checkSignal(limits));
	}

	/**
	 * Review the head of succeeded attempt `key`: return a completed or blocked
	 * review, adopt a running one, or record intent and run a read-only reviewer
	 * on the diff from `request.baseSha` to the head. A failed or skipped review
	 * with known spend is tried again; a completed one never is.
	 */
	async review(key: string, request: ReviewRequest, limits: RunLimits): Promise<ReviewState> {
		const attempt = await this.#stored(key);
		if (attempt.status !== "succeeded" || !attempt.headSha) throw new SupervisorBlockedError(`${key} is not a succeeded attempt.`);
		const recorded = attempt.review;
		if (recorded && recorded.headSha !== attempt.headSha) throw new SupervisorBlockedError(`${key} has a review of another head.`);
		if (recorded?.status === "running") return this.#adoptReview(attempt, recorded, request, limits);
		if (recorded && !reviewRetryable(recorded)) return recorded;
		const review = await this.#queue(() => this.#claimReview(attempt, request.model, limits));
		if (review.status !== "running") return review;
		let spawned = false;
		const ran = await this.#bounded(this.#reviewLimits(attempt, review, limits), async (signal, stopped) => {
			const options = this.#spawn(reviewRun(attempt.key, review), attempt.worktree!, signal, async (worker) => {
				spawned = true;
				await this.#recordReviewWorker(attempt, worker);
			});
			const diffFile = path.join(options.sessionDir, "task.diff");
			fs.writeFileSync(diffFile, await gitThrow(attempt.worktree!, ["diff", "--no-ext-diff", "--no-textconv", request.baseSha, attempt.headSha!, "--"]));
			const prompt = [correctnessSecurityTask({ cwd: attempt.worktree!, diffFile, intent: request.intent }), ...REVIEW_RULES].join("\n");
			const result = await runPilotProc(request.agent, prompt, { ...options, model: request.model, thinking: request.thinking });
			spawned ||= result.launched;
			return judgeRun(result, stopped());
		}).catch((error): Ran => spawned
			? { status: "blocked", spentUsd: null, reason: message(error) }
			: { status: "failed", spentUsd: 0, reason: `review did not start: ${message(error)}` });
		return this.#settleReview(attempt, request, ran);
	}

	/** The batch limits, ending earlier at the review's own time limit when that comes first. */
	#reviewLimits(attempt: AttemptState, review: Readonly<ReviewState>, limits: RunLimits): RunLimits {
		const limitMs = this.options.reviewTimeLimitMs ?? REVIEW_TIME_LIMIT_MS;
		const end = (review.startedAt ?? Date.now()) + limitMs;
		return {
			...limits, deadlineAt: review.stopReason ? Date.now() : Math.min(end, limits.deadlineAt), expiry: review.stopReason ?? "reviewer timed out",
			onStop: async (reason) => {
				const { store } = this.options;
				await store.harness.commit(async (tx) => {
					const current = (await tx.doc(store.contracts.AttemptDoc, attempt.key, attempt)).review;
					if (current?.status !== "running") throw new Error(`Review of ${attempt.key} is not running.`);
					current.stopReason ??= reason;
				}, store.context);
			},
		};
	}

	async #claimReview(attempt: AttemptState, model: string, limits: RunLimits): Promise<ReviewState> {
		const { store } = this.options;
		const plan = planReview(await store.read(), attempt.key, limits.deadlineAt);
		const skip = "skip" in plan ? plan.skip : null;
		const before = attempt.review;
		const review: ReviewState = {
			headSha: attempt.headSha!, status: skip ? "skipped" : "running", reservedUsd: "reserveUsd" in plan ? plan.reserveUsd : 0,
			spentUsd: 0, worker: null, blocking: 0, other: 0, findings: null, reason: skip,
			tries: before ? (before.tries ?? 1) + 1 : 1, earlierUsd: before ? (before.earlierUsd ?? 0) + before.spentUsd! : 0,
			startedAt: Date.now(), model, failures: reviewFailures(before),
		};
		await store.harness.commit(async (tx) => {
			if (!skip && (limits.signal?.aborted || limits.canStart?.() === false)) throw new AttemptNotStartedError("Stopped before review.");
			const draft = await tx.doc(store.contracts.AttemptDoc, attempt.key, attempt);
			if (draft.review && !reviewRetryable(draft.review)) throw new SupervisorBlockedError(`${attempt.key} already has a review.`);
			draft.review = review;
		}, store.context);
		return review;
	}

	async #recordReviewWorker(attempt: AttemptState, worker: WorkerIdentity): Promise<void> {
		const { store } = this.options;
		await store.harness.commit(async (tx) => {
			const review = (await tx.doc(store.contracts.AttemptDoc, attempt.key, attempt)).review;
			if (review?.status !== "running" || review.worker) throw new Error(`Review of ${attempt.key} cannot take a second worker.`);
			review.worker = worker;
		}, store.context);
	}

	async #adoptReview(attempt: AttemptState, review: ReviewState, request: ReviewRequest, limits: RunLimits): Promise<ReviewState> {
		if (!review.worker) throw new SupervisorBlockedError(`Review of ${attempt.key} has no recorded worker to adopt.`);
		const { sessionId, dir } = this.#session(reviewRun(attempt.key, review));
		const ran = await judgeOrphan(review.worker, dir, sessionId, this.#reviewLimits(attempt, review, limits), review)
			.catch((error): Ran => ({ status: "blocked", spentUsd: null, reason: message(error) }));
		return this.#settleReview(attempt, request, ran);
	}

	async #settleReview(attempt: AttemptState, request: ReviewRequest, ran: Ran): Promise<ReviewState> {
		const patch = ran.status === "settled" ? await this.#reviewResult(attempt, request, ran) : { status: ran.status, spentUsd: ran.spentUsd, reason: ran.reason };
		const { store } = this.options;
		await store.harness.commit(async (tx) => {
			const review = (await tx.doc(store.contracts.AttemptDoc, attempt.key, attempt)).review;
			if (review?.status !== "running") throw new Error(`Review of ${attempt.key} is not running.`);
			Object.assign(review, patch);
			if (ran.status === "failed" && ran.stopped) {
				review.spentUsd = Math.max(review.reservedUsd, ran.spentUsd ?? 0, ran.reportedUsd ?? 0);
				review.reservationCharged = true;
				review.reason = ran.reason === "cancelled" ? "reviewer cancelled by owner" : "reviewer timed out";
			}
			if (patch.status === "failed") {
				review.failures = (review.failures ?? 0) + 1;
				if (review.failures >= 2) review.reason = `review failed twice: ${review.reason}`;
			}
		}, store.context);
		return (await this.#stored(attempt.key)).review!;
	}

	async #reviewResult(attempt: AttemptState, request: ReviewRequest, ran: Extract<Ran, { status: "settled" }>): Promise<Partial<ReviewState>> {
		const changed = await changedFiles(attempt.worktree!, request.baseSha, attempt.headSha!).catch(() => null);
		if (!changed) return { status: "failed", spentUsd: ran.spentUsd, reason: "cannot list the reviewed files" };
		return { status: "done", spentUsd: ran.spentUsd, reason: null, ...parseReview(ran.text, changed) };
	}

	/** Push the feature tip to an allowlisted remote, then open one draft pull request for it. */
	async publish(request: PublishRequest): Promise<{ push: EffectOutcome; pullRequest?: EffectOutcome }> {
		const { store, featureRoot, featureBranch, allowlist, gh } = this.options;
		const push: PushTarget = { repoRoot: featureRoot, remote: request.remote, url: request.url, branch: featureBranch };
		const pr: PullRequestTarget = { repo: request.repo, base: request.base, head: featureBranch };
		await assertPublishTargets(allowlist, push, pr);
		if (!gh || !path.isAbsolute(gh)) throw new SupervisorBlockedError("Publishing needs an absolute gh executable.");
		const sha = request.headSha;
		if (await branchSha(featureRoot, featureBranch) !== sha) {
			throw new SupervisorBlockedError(`Feature branch ${featureBranch} moved from verified head ${sha}.`);
		}
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
