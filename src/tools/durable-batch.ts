/**
 * durable_batch — lets an agent draft a durable pilot batch and ask the user
 * to launch it. Only the user's confirmation in the Pi UI starts work.
 *
 * - draft: validate with `parseConfig`, save `<agent dir>/pi-dispatch/batches/<id>.json`.
 * - launch: show the batch, ask `ctx.ui.confirm`, then start one detached
 *   owner (`cli.ts run`, or `resume` when the store exists) logging to
 *   `<id>.log` next to the draft. Refused without a UI or inside a worker.
 * - status / stop: talk to the live owner over its socket.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, parseConfig, request, socketPath } from "../durable/cli.ts";
import { formatReport, type BatchReport, type PilotConfig } from "../durable/scheduler.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLI = fileURLToPath(new URL("../durable/cli.ts", import.meta.url));
const OWNER_WAIT_MS = 20_000;

export const batchesDir = (): string => path.join(getAgentDir(), "pi-dispatch", "batches");

interface Params {
	action: "draft" | "launch" | "status" | "stop";
	config?: unknown;
	id?: string;
	cancel?: boolean;
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });

function privateDir(): string {
	const dir = batchesDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	return dir;
}

function draftFile(id: string | undefined): string {
	if (!id || !SAFE_ID.test(id)) throw new Error("durable_batch: `id` must name a drafted batch.");
	return path.join(batchesDir(), `${id}.json`);
}

function loadDraft(id: string | undefined): { file: string; config: PilotConfig } {
	const file = draftFile(id);
	if (!fs.existsSync(file)) throw new Error(`durable_batch: no draft ${id}; draft it first.`);
	return { file, config: loadConfig(file) };
}

function draft(config: unknown): string {
	let parsed: PilotConfig;
	try {
		parsed = parseConfig(config);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	const file = path.join(privateDir(), `${parsed.batch.id}.json`);
	if (fs.existsSync(parsed.store)) return `Batch ${parsed.batch.id} already has a store at ${parsed.store}; its draft cannot change. Pick another batch id.`;
	fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	return `Draft saved: ${file}\n${summary(parsed, "run").join("\n")}\nAsk the user to approve, then call durable_batch with action "launch" and id "${parsed.batch.id}".`;
}

function summary(config: PilotConfig, mode: "run" | "resume"): string[] {
	const tasks = config.batch.tasks.map((t) => t.dependencies.length ? `${t.id} (after ${t.dependencies.join(", ")})` : t.id);
	return [
		`Batch: ${config.batch.id} (${mode})`,
		`Repository: ${config.repo.root}, base branch ${config.repo.baseBranch}`,
		`Tasks (${tasks.length}): ${tasks.join(", ")}`,
		`Worker model: ${config.worker.model} (${config.worker.thinking})`,
		`Spend allowance: $${config.spend.allowanceUsd} (reported usage, not a provider cap)`,
		`Deadline: ${config.limits.deadline}; up to ${config.limits.maxWorkers} workers, ${config.limits.maxAttemptsPerTask} attempts per task`,
		`Publication: draft PRs on ${config.publication.repo} via ${config.publication.remote} (${config.publication.url}); no merges`,
	];
}

/** Why this session may not ask for a launch, or undefined when it may. */
function launchRefusal(ctx: ExtensionContext): string | undefined {
	if ((Number.parseInt(process.env.PI_DISPATCH_DEPTH ?? "0", 10) || 0) > 0) return "workers cannot launch batches";
	if (!ctx.hasUI) return "this session has no interactive UI to ask the user";
	return undefined;
}

function tsxLoader(): string {
	try {
		return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
	} catch {
		throw new Error("durable_batch: tsx is not installed for pi-dispatch; run `npm ci` in the extension.");
	}
}

async function waitForOwner(config: PilotConfig, exited: () => boolean): Promise<boolean> {
	const until = Date.now() + OWNER_WAIT_MS;
	while (Date.now() < until && !exited()) {
		const live = await request(socketPath(config.store), { op: "status" }).catch(() => undefined);
		if (live?.ok) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

async function launch(params: Params, ctx: ExtensionContext): Promise<string> {
	const refused = launchRefusal(ctx);
	if (refused) return `Launch refused: ${refused}. Ask the user to run it from an interactive Pi session or the CLI.`;
	const { file, config } = loadDraft(params.id);
	if ((await request(socketPath(config.store), { op: "status" }).catch(() => undefined))?.ok) return `Batch ${config.batch.id} already has a live owner.`;
	const mode = fs.existsSync(config.store) ? "resume" : "run";
	const approved = await ctx.ui.confirm("Launch durable batch?", [...summary(config, mode), "", "Workers run unattended and spend money. Approve?"].join("\n"));
	if (!approved) return `Launch declined by the user; nothing started for ${config.batch.id}.`;
	const log = path.join(privateDir(), `${config.batch.id}.log`);
	const fd = fs.openSync(log, "a", 0o600);
	let exited = false;
	try {
		const child = spawn(process.execPath, ["--import", tsxLoader(), CLI, mode, file], {
			cwd: path.dirname(path.dirname(CLI)), detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PI_DISPATCH_DEPTH: "0" },
		});
		child.once("exit", () => { exited = true; });
		child.unref();
		const answering = await waitForOwner(config, () => exited);
		const state = answering ? "is running and answers status" : exited ? "exited early; read the log" : "has not answered status yet; read the log";
		return `Approved. Owner pid ${child.pid} ${state}.\nLog: ${log}`;
	} finally {
		fs.closeSync(fd);
	}
}

async function status(params: Params): Promise<string> {
	const { config } = loadDraft(params.id);
	const live = await request(socketPath(config.store), { op: "status" });
	if (!live?.ok) return `No live owner for ${config.batch.id}. Log: ${path.join(batchesDir(), `${config.batch.id}.log`)}`;
	return formatReport(live.report as BatchReport);
}

async function stop(params: Params): Promise<string> {
	const { config } = loadDraft(params.id);
	const reply = await request(socketPath(config.store), { op: "stop", cancel: params.cancel === true });
	if (!reply) return `No live owner for ${config.batch.id}.`;
	return params.cancel ? "Stopping and cancelling running workers." : "Draining: running workers finish, nothing new starts.";
}

export function registerDurableBatchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "durable_batch",
		label: "Durable batch",
		description:
			"Draft an unattended durable pilot batch (validated config saved under the Pi agent dir), ask the user to launch it, or check status/stop it. Launch always asks the user to confirm in the Pi UI; agents cannot start work themselves.",
		promptSnippet: "Draft durable overnight batches; launch only with user approval",
		promptGuidelines: [
			"durable_batch: Draft only when the user asks for an unattended batch. launch shows the batch and asks the user; never say a batch started unless launch returned an owner pid.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("draft"), Type.Literal("launch"), Type.Literal("status"), Type.Literal("stop")]),
			config: Type.Optional(Type.Any({ description: "draft: full batch configuration (see README, Durable pilot batches)" })),
			id: Type.Optional(Type.String({ description: "launch/status/stop: batch id of a saved draft" })),
			cancel: Type.Optional(Type.Boolean({ description: "stop: also cancel running workers" })),
		}),
		async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx) {
			if (params.action === "draft") return text(draft(params.config));
			if (params.action === "launch") return text(await launch(params, ctx));
			if (params.action === "status") return text(await status(params));
			return text(await stop(params));
		},
	});
}
