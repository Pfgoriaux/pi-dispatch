import type * as DurableModule from "@earendil-works/pi-durable";
import type { DurableRuntime } from "./compat.ts";

/** Persisted shape version of the documents below. Stores with another value are rejected. */
export const DURABLE_SCHEMA_VERSION = 1;

/** A process as `ps` saw it: PID plus start time, so a reused PID never matches. */
export type WorkerIdentity = { pid: number; startedAt: string; host: string };
export type PullRequestIdentity = { repo: string; number: number; headSha: string };
export type TaskReservation = { key: string; reserveUsd: number };

export type PolicyState = {
	/** False only inside the admission commit that creates the document. */
	admitted: boolean;
	schema: number;
	durableVersion: string;
	batchId: string;
	policyHash: string;
	maxWorkers: number;
	maxAttemptsPerTask: number;
	budgetUsd: number;
	reservedUsd: number;
	tasks: TaskReservation[];
	/** Durable ID of the admission receipt task. */
	admissionTaskId: number;
	/** Keys of every attempt and effect document, in creation order. */
	attempts: string[];
	effects: string[];
};

export type AttemptStatus = "reserved" | "running" | "succeeded" | "failed" | "interrupted" | "blocked";

/**
 * `done`: the reviewer answered. `failed`: it ran without a usable answer.
 * `skipped`: it never spawned (budget or deadline). Failed and skipped reviews
 * with known spend are retried on resume. `blocked`: its outcome is unknown, which halts the batch.
 */
export type ReviewStatus = "running" | "done" | "failed" | "skipped" | "blocked";
/** Read-only review of one succeeded attempt, bound to its head SHA. */
export type ReviewState = {
	headSha: string;
	status: ReviewStatus;
	/** 1 for the first review of this head; each retry adds one. Absent means 1. */
	tries?: number;
	/** Failed tries of this head; budget/deadline skips do not count. */
	failures?: number;
	/** Exact model selected for this try. */
	model?: string;
	/** Recorded before signalling the child, so a crash during cancellation is recoverable. */
	stopReason?: string;
	/** This try was charged its reservation rather than complete provider usage. */
	reservationCharged?: boolean;
	/** Known spend of earlier failed tries of this head. Absent means 0. */
	earlierUsd?: number;
	/** Epoch ms when this try was claimed; its time limit counts from here. */
	startedAt?: number;
	reservedUsd: number;
	/** `null` means unknown spend; recovery treats it as a halt. */
	spentUsd: number | null;
	worker: WorkerIdentity | null;
	/** Validated `[blocker]` findings. */
	blocking: number;
	/** Other reported findings. */
	other: number;
	/** Bounded reviewer report for the pull-request body and a fix attempt. */
	findings: string | null;
	reason: string | null;
};
export type AttemptState = {
	key: string;
	taskKey: string;
	attempt: number;
	status: AttemptStatus;
	reservedUsd: number;
	/** `null` means unknown spend; recovery treats it as a halt. */
	spentUsd: number | null;
	worker: WorkerIdentity | null;
	worktree: string | null;
	branch: string | null;
	baseSha: string | null;
	headSha: string | null;
	pr: PullRequestIdentity | null;
	reason: string | null;
	/** `undefined` or `null`: no review recorded. */
	review?: ReviewState | null;
};

export type EffectKind = "commit" | "push" | "pull-request";
/** `intended` is recorded before the effect runs; one that never became `applied` is `unresolved` after recovery. */
export type EffectStatus = "intended" | "applied" | "unresolved";
export type EffectState = {
	key: string;
	attemptKey: string;
	kind: EffectKind;
	status: EffectStatus;
	target: string;
	sha: string | null;
	pr: PullRequestIdentity | null;
};

export type AdmissionInput = { batchId: string; policyHash: string };
export type AdmissionCheckpoint = { phase: "admitted" };
export type AdmissionResult = { batchId: string };

/** Durable tokens built with the runtime's own Durable copy. */
export interface DurableContracts {
	readonly PolicyDoc: DurableModule.SessionDocToken<PolicyState>;
	readonly AttemptDoc: DurableModule.SessionDocFamilyToken<AttemptState, AttemptState>;
	readonly EffectDoc: DurableModule.SessionDocFamilyToken<EffectState, EffectState>;
	readonly AdmissionTask: DurableModule.Task<AdmissionInput, AdmissionCheckpoint, AdmissionResult, object>;
	readonly extension: DurableModule.Extension;
}

export const attemptKey = (taskKey: string, attempt: number): string => `${taskKey}#${attempt}`;

const contractsByRuntime = new WeakMap<DurableRuntime, DurableContracts>();

function buildContracts({ durable }: DurableRuntime): DurableContracts {
	const PolicyDoc = durable.defineDoc<PolicyState>({
		kind: "pi-dispatch.policy",
		version: DURABLE_SCHEMA_VERSION,
		scope: "session",
		initial: () => ({
			admitted: false, schema: DURABLE_SCHEMA_VERSION, durableVersion: "", batchId: "", policyHash: "",
			maxWorkers: 0, maxAttemptsPerTask: 0, budgetUsd: 0, reservedUsd: 0, tasks: [], admissionTaskId: 0,
			attempts: [], effects: [],
		}),
	});
	const AttemptDoc = durable.defineDocFamily<AttemptState, AttemptState>({
		kind: "pi-dispatch.attempt",
		version: DURABLE_SCHEMA_VERSION,
		family: true,
		scope: "session",
		initial: (seed) => structuredClone(seed),
	});
	const EffectDoc = durable.defineDocFamily<EffectState, EffectState>({
		kind: "pi-dispatch.effect",
		version: DURABLE_SCHEMA_VERSION,
		family: true,
		scope: "session",
		initial: (seed) => structuredClone(seed),
	});
	// The admission receipt. Its only phase completes; it never calls a model.
	const AdmissionTask = durable.defineTask<AdmissionInput, AdmissionCheckpoint, AdmissionResult>({
		name: "pi-dispatch.admission",
		version: DURABLE_SCHEMA_VERSION,
		initial: () => ({ phase: "admitted" }),
		phases: {
			admitted: async (task, runtime, context) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { batchId: task.input.batchId } } }),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	const extension = durable.defineExtension({ name: "pi-dispatch.durable", tasks: [AdmissionTask] });
	return { PolicyDoc, AttemptDoc, EffectDoc, AdmissionTask, extension };
}

export function durableContracts(runtime: DurableRuntime): DurableContracts {
	let contracts = contractsByRuntime.get(runtime);
	if (!contracts) contractsByRuntime.set(runtime, contracts = buildContracts(runtime));
	return contracts;
}

/** Create or replace one attempt document and index it, inside the caller's commit. */
export async function putAttempt(contracts: DurableContracts, tx: DurableModule.Tx, attempt: AttemptState): Promise<void> {
	await putIndexed(tx, contracts, "attempts", contracts.AttemptDoc, attempt);
}

/** Create or replace one effect document and index it, inside the caller's commit. */
export async function putEffect(contracts: DurableContracts, tx: DurableModule.Tx, effect: EffectState): Promise<void> {
	await putIndexed(tx, contracts, "effects", contracts.EffectDoc, effect);
}

async function putIndexed<T extends AttemptState | EffectState>(
	tx: DurableModule.Tx,
	contracts: DurableContracts,
	index: "attempts" | "effects",
	token: DurableModule.SessionDocFamilyToken<T, T>,
	value: T,
): Promise<void> {
	const policy = await tx.doc(contracts.PolicyDoc);
	if (!policy.admitted) throw new Error(`Cannot record ${index} before batch admission.`);
	const draft = await tx.doc(token, value.key, value) as Record<string, unknown>;
	Object.assign(draft, structuredClone(value));
	if (!policy[index].includes(value.key)) policy[index].push(value.key);
}

/** Worker processes the store shows running: attempts and reviews. */
export function runningWorkers(attempts: readonly Readonly<AttemptState>[]): number {
	return attempts.filter((a) => a.status === "running").length + attempts.filter((a) => a.review?.status === "running").length;
}

/** Spend held against the budget: reservations while pending or running, then reported spend. Unknown spend counts as infinite. */
export function committedUsd(attempts: readonly Readonly<AttemptState>[]): number {
	const held = (status: string, reserved: number, spent: number | null) =>
		status === "reserved" || status === "running" ? reserved : spent ?? Infinity;
	return attempts.reduce((sum, a) => sum + held(a.status, a.reservedUsd, a.spentUsd)
		+ (a.review ? held(a.review.status, a.review.reservedUsd, a.review.spentUsd) + (a.review.earlierUsd ?? 0) : 0), 0);
}

/** Reported spend of started attempts and their reviews; `null` when any is unknown. */
export function reportedUsd(attempts: readonly Readonly<AttemptState>[]): number | null {
	const amounts = attempts.filter((a) => a.status !== "reserved")
		.flatMap((a) => [a.spentUsd, ...(a.review ? [a.review.spentUsd, a.review.earlierUsd ?? 0] : [])]);
	return amounts.some((usd) => usd === null) ? null : (amounts as number[]).reduce((sum, usd) => sum + usd, 0);
}

/** Old records did not count failures separately from skipped claims. */
export const reviewFailures = (review: Readonly<ReviewState> | null | undefined): number =>
	review?.failures ?? (review?.status === "failed" ? 1 : 0);

/** Skips do not exhaust retries; two failed tries block this head, not the batch. */
export const reviewRetryable = (review: Readonly<ReviewState> | null | undefined): boolean =>
	(review?.status === "failed" || review?.status === "skipped") && review.spentUsd !== null && reviewFailures(review) < 2;
