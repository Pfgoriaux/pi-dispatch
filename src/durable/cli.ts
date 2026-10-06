/**
 * Durable pilot CLI: `node --import tsx src/durable/cli.ts run|resume|status|stop <config.json> [--json] [--cancel] [--expect-hash=<policy hash>]`.
 *
 * The process that runs or resumes a batch owns its store until it exits and
 * answers `status`/`stop` over a Unix socket in a private per-user directory.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { bundledAgentsDir } from "../agents.ts";
import { THINKING_LEVELS, type AgentConfig, type ThinkingLevel } from "../types.ts";
import { DurableStoreLockedError } from "./store.ts";
import {
	dependencyOrder, formatReport, MAX_ATTEMPTS_PER_TASK, MAX_WORKERS, openBatch, policyHash,
	type BatchOwner, type BatchReport, type BatchTaskSpec, type PilotConfig,
} from "./scheduler.ts";

export class ConfigError extends Error {
	override name = "ConfigError";
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
type Raw = Record<string, unknown>;

/** Collects every problem so one run reports all missing or invalid inputs. */
class Reader {
	readonly problems: string[] = [];

	object(value: unknown, where: string): Raw {
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Raw;
		this.problems.push(`${where} must be an object`);
		return {};
	}

	string(raw: Raw, key: string, where: string, test: (value: string) => boolean = Boolean, hint = "a non-empty string"): string {
		const value = raw[key];
		if (typeof value === "string" && test(value)) return value;
		this.problems.push(`${where}.${key} must be ${hint}`);
		return "";
	}

	absolute(raw: Raw, key: string, where: string): string {
		return this.string(raw, key, where, path.isAbsolute, "an absolute path");
	}

	strings(raw: Raw, key: string, where: string, minimum: number): string[] {
		const value = raw[key];
		const ok = Array.isArray(value) && value.length >= minimum && value.every((item) => typeof item === "string" && item.length > 0);
		if (ok) return value as string[];
		this.problems.push(`${where}.${key} must be an array of at least ${minimum} non-empty string${minimum === 1 ? "" : "s"}`);
		return [];
	}

	integer(raw: Raw, key: string, where: string, max: number): number {
		const value = raw[key];
		if (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max) return value as number;
		this.problems.push(`${where}.${key} must be an integer from 1 to ${max}`);
		return 0;
	}

	amount(value: unknown, where: string): number {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
		this.problems.push(`${where} must be a positive USD amount`);
		return 0;
	}
}

const relativePath = (file: string) => !path.isAbsolute(file) && !file.split("/").includes("..");

function readTask(r: Reader, value: unknown, i: number): BatchTaskSpec {
	const where = `batch.tasks[${i}]`;
	const raw = r.object(value, where);
	const ownedFiles = r.strings(raw, "ownedFiles", where, 1);
	if (!ownedFiles.every(relativePath)) r.problems.push(`${where}.ownedFiles must be repository-relative paths`);
	const checks = Array.isArray(raw.checks) ? raw.checks : [];
	const argvOk = (argv: unknown) => Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === "string") && argv[0] !== "";
	if (checks.length === 0 || !checks.every(argvOk)) r.problems.push(`${where}.checks must be a non-empty array of argv arrays`);
	const dependencies = r.strings(raw, "dependencies", where, 0);
	if (new Set(dependencies).size !== dependencies.length) r.problems.push(`${where}.dependencies must not repeat`);
	return {
		id: r.string(raw, "id", where, (v) => SAFE_ID.test(v), "a safe identifier"),
		dependencies,
		ownedFiles,
		checks: checks as string[][],
		prompt: r.string(raw, "prompt", where),
	};
}

function readSpend(r: Reader, value: unknown, tasks: readonly BatchTaskSpec[]): PilotConfig["spend"] {
	const raw = r.object(value, "spend");
	const allowanceUsd = r.amount(raw.allowanceUsd, "spend.allowanceUsd");
	const given = r.object(raw.reservations, "spend.reservations");
	const reservations = Object.fromEntries(tasks.map((task) => [task.id, r.amount(given[task.id], `spend.reservations.${task.id}`)]));
	const extra = Object.keys(given).filter((key) => !tasks.some((task) => task.id === key));
	if (extra.length > 0) r.problems.push(`spend.reservations names unknown tasks: ${extra.join(", ")}`);
	const reserved = Object.values(reservations).reduce((sum, usd) => sum + usd, 0);
	if (reserved > allowanceUsd) r.problems.push(`spend.reservations total ${reserved} exceeds spend.allowanceUsd ${allowanceUsd}`);
	return { allowanceUsd, reservations };
}

function readLimits(r: Reader, value: unknown): PilotConfig["limits"] {
	const raw = r.object(value, "limits");
	const deadline = r.string(raw, "deadline", "limits", (v) => ZONED_ISO.test(v) && Number.isFinite(Date.parse(v)), "an absolute ISO 8601 time with a zone");
	return {
		maxWorkers: r.integer(raw, "maxWorkers", "limits", MAX_WORKERS),
		maxAttemptsPerTask: r.integer(raw, "maxAttemptsPerTask", "limits", MAX_ATTEMPTS_PER_TASK),
		deadline,
	};
}

function readBatch(r: Reader, value: unknown): PilotConfig["batch"] {
	const raw = r.object(value, "batch");
	const id = r.string(raw, "id", "batch", (v) => SAFE_ID.test(v), "a safe identifier");
	const list = Array.isArray(raw.tasks) ? raw.tasks : [];
	if (list.length === 0) r.problems.push("batch.tasks must be a non-empty array");
	const tasks = list.map((task, i) => readTask(r, task, i));
	const ids = tasks.map((task) => task.id);
	if (new Set(ids).size !== ids.length) r.problems.push("batch.tasks ids must be unique");
	try { dependencyOrder(tasks); } catch (error) { r.problems.push((error as Error).message); }
	return { id, tasks };
}

/** Validate a batch configuration. Every field is required; caps, spend, deadline, and publication fail closed. */
export function parseConfig(value: unknown): PilotConfig {
	const r = new Reader();
	const raw = r.object(value, "config");
	const batch = readBatch(r, raw.batch);
	const repo = r.object(raw.repo, "repo");
	const worker = r.object(raw.worker, "worker");
	const publication = r.object(raw.publication, "publication");
	const prefixArgs = worker.piPrefixArgs === undefined ? undefined : r.strings(worker, "piPrefixArgs", "worker", 0);
	const config: PilotConfig = {
		batch,
		spend: readSpend(r, raw.spend, batch.tasks),
		limits: readLimits(r, raw.limits),
		store: r.absolute(raw, "store", "config"),
		repo: {
			root: r.absolute(repo, "root", "repo"),
			baseBranch: r.string(repo, "baseBranch", "repo"),
			worktreesRoot: r.absolute(repo, "worktreesRoot", "repo"),
			sessionsRoot: r.absolute(repo, "sessionsRoot", "repo"),
			branchPrefix: r.string(repo, "branchPrefix", "repo", (v) => v.split("/").every((part) => SAFE_ID.test(part)), "safe branch path segments"),
		},
		worker: {
			piExecutable: r.absolute(worker, "piExecutable", "worker"),
			...(prefixArgs ? { piPrefixArgs: prefixArgs } : {}),
			model: r.string(worker, "model", "worker", (v) => /^[^/\s]+\/\S+$/.test(v), "an exact provider/id"),
			thinking: r.string(worker, "thinking", "worker", (v) => THINKING_LEVELS.has(v), "a thinking level") as ThinkingLevel,
		},
		publication: {
			remote: r.string(publication, "remote", "publication"),
			url: r.string(publication, "url", "publication"),
			repo: r.string(publication, "repo", "publication", (v) => /^[^/\s]+\/[^/\s]+$/.test(v), "owner/name"),
			gh: r.absolute(publication, "gh", "publication"),
		},
	};
	if (r.problems.length > 0) throw new ConfigError(`Invalid batch configuration:\n- ${r.problems.join("\n- ")}`);
	return config;
}

export function loadConfig(file: string): PilotConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new ConfigError(`Cannot read batch configuration ${file}: ${(error as Error).message}`);
	}
	return parseConfig(raw);
}

function bundledAgent(file: string, onlyTools?: readonly string[]): AgentConfig {
	const filePath = path.join(bundledAgentsDir(), file);
	const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown; tools?: unknown }>(fs.readFileSync(filePath, "utf8"));
	const listed = typeof frontmatter.tools === "string" ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
	const tools = onlyTools ? listed?.filter((tool) => onlyTools.includes(tool)) : listed;
	return {
		name: String(frontmatter.name ?? path.basename(file, ".md")), description: String(frontmatter.description ?? ""), tools,
		systemPrompt: body.trim(), source: "bundled", filePath,
	};
}

/**
 * Commit-only pilot writer. The model comes from the configuration. It lives in
 * `agents/durable/`, outside the dispatch roster, so dispatch cannot pick it.
 */
export const writerAgent = (): AgentConfig => bundledAgent("durable/writer.md");

/** The bundled reviewer with read-only tools only: it reads the saved diff instead of running Git. */
export const reviewerAgent = (): AgentConfig => bundledAgent("reviewer.md", ["read", "grep", "find", "ls"]);

const batchAgents = () => ({ agent: writerAgent(), reviewer: reviewerAgent() });

/** Owner socket for a store: a private per-user directory, keyed by the store path. */
export function socketPath(storePath: string): string {
	const dir = path.join(os.tmpdir(), `pi-dispatch-${process.getuid?.() ?? "user"}`);
	const file = path.join(dir, `${createHash("sha256").update(path.resolve(storePath)).digest("hex").slice(0, 16)}.sock`);
	// macOS limits Unix socket paths to 103 bytes.
	if (Buffer.byteLength(file) > 100) throw new Error(`Socket path ${file} is too long; set TMPDIR to a shorter directory.`);
	return file;
}

function privateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	const mine = process.getuid === undefined || stat.uid === process.getuid();
	if (!stat.isDirectory() || !mine || (stat.mode & 0o077) !== 0) throw new Error(`Refusing IPC directory ${dir}: not a private directory of this user.`);
}

type Request = { op: "status" } | { op: "stop"; cancel: boolean };

async function answer(owner: BatchOwner, request: Request): Promise<unknown> {
	if (request.op === "status") return { ok: true, owner: { pid: process.pid, draining: owner.draining }, report: await owner.report() };
	void owner.stop(request.cancel);
	return { ok: true, stopping: true, cancel: request.cancel };
}

/** Serve status/stop to local clients. The store owner lock guarantees any older socket is stale. */
async function serve(owner: BatchOwner, file: string): Promise<net.Server> {
	privateDir(path.dirname(file));
	fs.rmSync(file, { force: true });
	const server = net.createServer((socket) => {
		let input = "";
		socket.setEncoding("utf8");
		socket.on("error", () => undefined);
		socket.on("data", (chunk: string) => {
			input += chunk;
			if (input.length > 4096) return void socket.destroy();
			if (!input.includes("\n")) return;
			let request: Request;
			try { request = JSON.parse(input) as Request; } catch { return void socket.end(`${JSON.stringify({ ok: false, error: "bad request" })}\n`); }
			const known = request.op === "status" || request.op === "stop";
			const reply = known ? answer(owner, request) : Promise.resolve({ ok: false, error: "unknown op" });
			reply.then((body) => socket.end(`${JSON.stringify(body)}\n`), (error) => socket.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`));
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(file, () => resolve()); });
	fs.chmodSync(file, 0o600);
	return server;
}

/** One request to the owner; `undefined` when no owner listens. */
export async function request(file: string, body: Request): Promise<Record<string, unknown> | undefined> {
	privateDir(path.dirname(file));
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
			throw new Error("Refusing socket not privately owned by this user.");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return new Promise((resolve, reject) => {
		const socket = net.connect(file);
		socket.setTimeout(5000, () => socket.destroy(new Error("Owner request timed out.")));
		let output = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
		socket.on("data", (chunk: string) => { output += chunk; });
		socket.on("end", () => {
			try { resolve(JSON.parse(output) as Record<string, unknown>); } catch { reject(new Error("Owner sent an unreadable reply.")); }
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
			else reject(error);
		});
	});
}

interface Io { out: (text: string) => void; err: (text: string) => void; json: boolean }

const print = (io: Io, report: BatchReport, extra: object = {}) =>
	io.out(io.json ? JSON.stringify({ ...extra, report }, null, 2) : formatReport(report));

/** Own the store for a run or resume: preflight, serve IPC, schedule, report. */
async function own(config: PilotConfig, mode: "run" | "resume", io: Io): Promise<number> {
	const owner = await openBatch(config, { ...batchAgents(), onWarning: (warning) => io.err(`warning: ${warning}`) });
	const file = socketPath(config.store);
	let server: net.Server | undefined;
	let signals = 0;
	const onSignal = () => {
		signals++;
		io.err(signals === 1 ? "Stopping: no new attempts; running attempts finish first. Signal again to cancel them." : "Cancelling running attempts.");
		void owner.stop(signals > 1);
	};
	const onHangup = () => { void owner.stop(true); };
	try {
		if (mode === "run") await owner.create();
		else await owner.attach();
		const refused = await owner.preflight();
		if (refused.length > 0) {
			io.err(`Refusing to schedule batch ${config.batch.id}:\n- ${refused.join("\n- ")}`);
			print(io, await owner.report(), { refused });
			return 2;
		}
		server = await serve(owner, file);
		process.on("SIGINT", onSignal).on("SIGTERM", onSignal);
		process.on("SIGHUP", onHangup);
		print(io, await owner.execute());
		return 0;
	} finally {
		process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
		process.off("SIGHUP", onHangup);
		if (server) await new Promise((resolve) => server!.close(resolve));
		await owner.close();
	}
}

/** Ask the live owner; without one, open the store (recovery runs) and report without scheduling. */
async function status(config: PilotConfig, io: Io): Promise<number> {
	const live = await request(socketPath(config.store), { op: "status" });
	if (live?.ok) {
		io.out(io.json ? JSON.stringify(live, null, 2) : formatReport(live.report as BatchReport));
		return 0;
	}
	if (!fs.existsSync(config.store)) throw new Error(`Store ${config.store} does not exist.`);
	const owner = await openBatch(config, batchAgents()).catch((error: unknown) => {
		if (error instanceof DurableStoreLockedError) throw new Error("Another process owns the store, but its status socket does not answer.");
		throw error;
	});
	try {
		print(io, await owner.report(), { owner: null });
		return 0;
	} finally {
		await owner.close();
	}
}

async function stop(config: PilotConfig, cancel: boolean, io: Io): Promise<number> {
	const reply = await request(socketPath(config.store), { op: "stop", cancel });
	if (!reply) {
		io.err("No owner is running for this store.");
		return 1;
	}
	io.out(JSON.stringify(reply));
	return reply.ok ? 0 : 1;
}

const USAGE = "Usage: node --import tsx src/durable/cli.ts run|resume|status|stop <config.json> [--json] [--cancel] [--expect-hash=<policy hash>]";
const EXPECT = "--expect-hash=";

export async function main(argv: readonly string[], io: Io = { out: console.log, err: console.error, json: false }): Promise<number> {
	const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
	const [command, file, ...rest] = argv.filter((arg) => !arg.startsWith("--"));
	const expected = [...flags].find((flag) => flag.startsWith(EXPECT))?.slice(EXPECT.length);
	const unknown = [...flags].filter((flag) => flag !== "--json" && flag !== "--cancel" && !flag.startsWith(EXPECT));
	if (!file || rest.length > 0 || unknown.length > 0 || !["run", "resume", "status", "stop"].includes(command)) {
		io.err(USAGE);
		return 64;
	}
	const ioWithFormat = { ...io, json: flags.has("--json") };
	try {
		const config = loadConfig(file);
		// A launch approved in the Pi UI runs only the configuration the user saw.
		if (expected !== undefined && policyHash(config) !== expected) throw new ConfigError(`${file} changed after approval; nothing started.`);
		if (command === "status") return await status(config, ioWithFormat);
		if (command === "stop") return await stop(config, flags.has("--cancel"), ioWithFormat);
		return await own(config, command as "run" | "resume", ioWithFormat);
	} catch (error) {
		io.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
