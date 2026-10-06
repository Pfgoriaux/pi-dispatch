import { execFile } from "node:child_process";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type * as DurableModule from "@earendil-works/pi-durable";
import { loadDurableRuntime, type DurableContext, type DurableRuntime } from "./compat.ts";
import {
	attemptKey, durableContracts, DURABLE_SCHEMA_VERSION, putAttempt,
	type AttemptState, type DurableContracts, type EffectState, type PolicyState, type TaskReservation, type WorkerIdentity,
} from "./contracts.ts";

const exec = promisify(execFile);

export class DurableStoreLockedError extends Error {
	override name = "DurableStoreLockedError";
}
export class DurableStoreMismatchError extends Error {
	override name = "DurableStoreMismatchError";
}

export interface DurableStoreIdentity { readonly batchId: string; readonly policyHash: string }
export interface OpenDurableStoreOptions extends DurableStoreIdentity {
	/** Durable SQLite file. The owner lock lives next to it in `<path>.owner-lock.sqlite`. */
	readonly path: string;
	readonly runtime?: DurableRuntime;
}
export interface AdmissionRequest {
	readonly maxWorkers: number;
	readonly maxAttemptsPerTask: number;
	readonly budgetUsd: number;
	readonly tasks: readonly TaskReservation[];
}
export interface AdmissionReceipt { readonly status: "admitted" | "duplicate"; readonly taskId: number }
export interface StoreSnapshot {
	readonly policy: Readonly<PolicyState> | undefined;
	readonly attempts: readonly Readonly<AttemptState>[];
	readonly effects: readonly Readonly<EffectState>[];
}
export interface RecoveryReport {
	readonly interrupted: readonly string[];
	readonly blocked: readonly string[];
	readonly unresolvedEffects: readonly string[];
	readonly unknownSpend: readonly string[];
	/** True when any of the lists above prevents further automatic work. */
	readonly halted: boolean;
}

export const ownerLockPath = (storePath: string): string => `${storePath}.owner-lock.sqlite`;

const SQLITE_BUSY = 5;

/** Hold `BEGIN EXCLUSIVE` on a separate SQLite file; the OS releases it if the process dies. */
function acquireOwnerLock(lockPath: string): DatabaseSync {
	const db = new DatabaseSync(lockPath);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("PRAGMA journal_mode = DELETE");
		db.exec("BEGIN EXCLUSIVE");
		return db;
	} catch (error) {
		db.close();
		if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
		throw new DurableStoreLockedError(`Durable store is owned by another process or handle (${lockPath}).`, { cause: error });
	}
}

function releaseOwnerLock(db: DatabaseSync): void {
	try { db.exec("ROLLBACK"); } finally { db.close(); }
}

/** Start identity of a live PID, `null` when no such process exists, `undefined` when unknown. */
export async function processStartIdentity(pid: number): Promise<string | null | undefined> {
	if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], {
			timeout: 2000, env: { ...process.env, LC_ALL: "C" },
		});
		return stdout.trim() || undefined;
	} catch (error) {
		const failure = error as { code?: unknown; stdout?: string };
		return failure.code === 1 && !failure.stdout?.trim() ? null : undefined;
	}
}

/** Identity to record for a worker process; rejects when it cannot be established. */
export async function workerIdentity(pid: number): Promise<WorkerIdentity> {
	const startedAt = await processStartIdentity(pid);
	if (!startedAt) throw new Error(`Cannot establish start identity of process ${pid}.`);
	return { pid, startedAt, host: os.hostname() };
}

type Liveness = "dead" | "alive" | "unknown";

async function workerLiveness(worker: WorkerIdentity | null): Promise<Liveness> {
	if (!worker || worker.host !== os.hostname()) return "unknown";
	const current = await processStartIdentity(worker.pid);
	if (current === undefined) return "unknown";
	return current === worker.startedAt ? "alive" : "dead";
}

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
}

function assertAmount(name: string, value: number): void {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a known non-negative amount.`);
}

function normalizeAdmission(request: AdmissionRequest): AdmissionRequest & { reservedUsd: number } {
	assertPositiveInteger("maxWorkers", request.maxWorkers);
	assertPositiveInteger("maxAttemptsPerTask", request.maxAttemptsPerTask);
	assertAmount("budgetUsd", request.budgetUsd);
	if (request.tasks.length === 0) throw new RangeError("Admission needs at least one task.");
	const keys = new Set<string>();
	for (const task of request.tasks) {
		if (!task.key || task.key.includes("#") || keys.has(task.key)) throw new RangeError(`Invalid or duplicate task key "${task.key}".`);
		keys.add(task.key);
		assertAmount(`reserveUsd for ${task.key}`, task.reserveUsd);
	}
	const reservedUsd = request.tasks.reduce((sum, task) => sum + task.reserveUsd, 0);
	if (reservedUsd > request.budgetUsd) throw new RangeError(`Reservations ${reservedUsd} exceed budget ${request.budgetUsd}.`);
	const tasks = request.tasks.map(({ key, reserveUsd }) => ({ key, reserveUsd }));
	return { ...request, tasks, reservedUsd };
}

function samePolicy(policy: Readonly<PolicyState>, request: AdmissionRequest): boolean {
	return policy.maxWorkers === request.maxWorkers
		&& policy.maxAttemptsPerTask === request.maxAttemptsPerTask
		&& policy.budgetUsd === request.budgetUsd
		&& JSON.stringify(policy.tasks) === JSON.stringify(request.tasks);
}

function reservedAttempt(task: TaskReservation): AttemptState {
	return {
		key: attemptKey(task.key, 1), taskKey: task.key, attempt: 1, status: "reserved",
		reservedUsd: task.reserveUsd, spentUsd: 0, worker: null, worktree: null, branch: null,
		baseSha: null, headSha: null, pr: null, reason: null,
	};
}

/** One owned, open durable store. Use `openDurableStore()`. */
export class DurableStore {
	readonly contracts: DurableContracts;
	readonly context: DurableContext;
	recovery: RecoveryReport = { interrupted: [], blocked: [], unresolvedEffects: [], unknownSpend: [], halted: false };
	#closed = false;

	constructor(
		readonly runtime: DurableRuntime,
		readonly harness: DurableModule.Harness,
		readonly identity: DurableStoreIdentity,
		private readonly lock: DatabaseSync,
	) {
		this.contracts = durableContracts(runtime);
		this.context = runtime.context;
	}

	async read(): Promise<StoreSnapshot> {
		const { PolicyDoc, AttemptDoc, EffectDoc } = this.contracts;
		const policy = await this.harness.snapshot(PolicyDoc, this.context);
		const attempts = await Promise.all((policy?.attempts ?? []).map((key) => this.harness.snapshot(AttemptDoc, key, this.context)));
		const effects = await Promise.all((policy?.effects ?? []).map((key) => this.harness.snapshot(EffectDoc, key, this.context)));
		return { policy, attempts: attempts.filter((a) => a !== undefined), effects: effects.filter((e) => e !== undefined) };
	}

	/**
	 * Admit the batch in one commit: policy, attempt-1 reservations, and the
	 * admission receipt task. Repeating an identical admission returns the
	 * existing receipt; any difference is rejected.
	 */
	async admit(request: AdmissionRequest): Promise<AdmissionReceipt> {
		const admission = normalizeAdmission(request);
		const { PolicyDoc, AdmissionTask } = this.contracts;
		const root = await this.harness.root(this.context);
		return root.commit(async (tx) => {
			const policy = await tx.doc(PolicyDoc);
			if (policy.admitted) {
				if (!samePolicy(policy, admission)) throw new DurableStoreMismatchError(`Batch ${policy.batchId} was admitted with a different policy.`);
				return { status: "duplicate", taskId: policy.admissionTaskId };
			}
			const taskId = await tx.createTask(AdmissionTask, { ...this.identity }, { ownership: { kind: "conversation" }, background: true });
			Object.assign(policy, {
				admitted: true, schema: DURABLE_SCHEMA_VERSION, durableVersion: this.runtime.versions["@earendil-works/pi-durable"],
				...this.identity, maxWorkers: admission.maxWorkers, maxAttemptsPerTask: admission.maxAttemptsPerTask,
				budgetUsd: admission.budgetUsd, reservedUsd: admission.reservedUsd, tasks: admission.tasks, admissionTaskId: taskId,
			});
			for (const task of admission.tasks) await putAttempt(this.contracts, tx, reservedAttempt(task));
			return { status: "admitted", taskId };
		}, this.context);
	}

	/**
	 * Settle state left by a previous owner. Running attempts become
	 * `interrupted` when their worker is gone, else `blocked`; intended effects
	 * become `unresolved`. Unknown identity or spend halts instead of retrying.
	 */
	async recover(): Promise<RecoveryReport> {
		const before = await this.read();
		const running = before.attempts.filter((attempt) => attempt.status === "running");
		const liveness = new Map(await Promise.all(running.map(async (a) => [a.key, await workerLiveness(a.worker)] as const)));
		if (liveness.size > 0 || before.effects.some((effect) => effect.status === "intended")) {
			await this.harness.commit((tx) => this.#settle(tx, running, liveness, before.effects), this.context);
		}
		const after = await this.read();
		const keys = <T extends { key: string }>(items: readonly T[], keep: (item: T) => boolean) => items.filter(keep).map((item) => item.key);
		const report = {
			interrupted: keys(after.attempts, (a) => a.status === "interrupted"),
			blocked: keys(after.attempts, (a) => a.status === "blocked"),
			unresolvedEffects: keys(after.effects, (e) => e.status === "unresolved"),
			unknownSpend: keys(after.attempts, (a) => a.spentUsd === null),
		};
		this.recovery = { ...report, halted: Object.values(report).some((list) => list.length > 0) };
		return this.recovery;
	}

	async #settle(
		tx: DurableModule.Tx,
		running: readonly Readonly<AttemptState>[],
		liveness: ReadonlyMap<string, Liveness>,
		effects: readonly Readonly<EffectState>[],
	): Promise<void> {
		const { AttemptDoc, EffectDoc } = this.contracts;
		for (const seen of running) {
			const attempt = await tx.doc(AttemptDoc, seen.key, seen);
			const state = liveness.get(seen.key);
			if (attempt.status !== "running") continue;
			attempt.status = state === "dead" ? "interrupted" : "blocked";
			attempt.spentUsd = null;
			attempt.reason = state === "dead" ? "worker exited without a recorded outcome" : `worker identity is ${state}`;
		}
		for (const effect of effects.filter((e) => e.status === "intended")) {
			(await tx.doc(EffectDoc, effect.key, effect)).status = "unresolved";
		}
	}

	/** Close the Harness, then release the owner lock. Idempotent. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try { await this.harness.close(this.context); } finally { releaseOwnerLock(this.lock); }
	}
}

function assertIdentity(policy: Readonly<PolicyState> | undefined, identity: DurableStoreIdentity, durableVersion: string): void {
	if (!policy) return;
	const expected = { schema: DURABLE_SCHEMA_VERSION, durableVersion, ...identity };
	const actual = { schema: policy.schema, durableVersion: policy.durableVersion, batchId: policy.batchId, policyHash: policy.policyHash };
	if (JSON.stringify(actual) === JSON.stringify(expected)) return;
	throw new DurableStoreMismatchError(`Store identity ${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}.`);
}

/**
 * Take exclusive ownership of a durable SQLite store and open a Harness on it
 * with providerless models. Fails closed on version, identity, or owner conflicts.
 * Runs recovery before returning; inspect `store.recovery.halted`.
 */
export async function openDurableStore(options: OpenDurableStoreOptions): Promise<DurableStore> {
	if (!options.batchId || !options.policyHash) throw new RangeError("Durable store needs a batch ID and policy hash.");
	const runtime = options.runtime ?? await loadDurableRuntime();
	const lock = acquireOwnerLock(ownerLockPath(options.path));
	let store: DurableStore | undefined;
	try {
		const storage = await runtime.sqlite.openNodeSqliteStorage(options.path);
		const contracts = durableContracts(runtime);
		const registry = runtime.durable.createRegistry();
		registry.install(contracts.extension);
		const harness = await runtime.durable.Harness.open(storage, { models: runtime.createModels(), registry }, runtime.context)
			.catch(async (error: unknown) => { await storage.close(runtime.context); throw error; });
		const identity = { batchId: options.batchId, policyHash: options.policyHash };
		store = new DurableStore(runtime, harness, identity, lock);
		assertIdentity(await harness.snapshot(contracts.PolicyDoc, runtime.context), identity, runtime.versions["@earendil-works/pi-durable"]);
		await store.recover();
		return store;
	} catch (error) {
		if (store) await store.close();
		else releaseOwnerLock(lock);
		throw error;
	}
}
