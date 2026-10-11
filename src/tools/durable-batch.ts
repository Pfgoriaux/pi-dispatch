/** durable_batch asks for user approval; Foreman owns validation and execution. */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForemanClient } from "../foreman-client.ts";
import type { BatchReport, BatchTaskSpec, PilotConfig } from "../durable/scheduler.ts";
import type { ThinkingLevel } from "../types.ts";
import { truncateText } from "../worker.ts";
import { HETZNER_DRAFT_GUIDANCE } from "./feature-plan-prompts.ts";

type ForemanTask = BatchTaskSpec & {
	model?: string;
	thinking?: ThinkingLevel;
	reviewModel?: string;
	modelFallbacks?: readonly string[];
};
type ForemanConfig = Omit<PilotConfig, "reviewer" | "batch" | "worker"> & {
	executor?: string;
	batch: { id: string; tasks: readonly ForemanTask[] };
	worker: PilotConfig["worker"] & { reviewModel?: string; reviewThinking?: ThinkingLevel };
};
interface Draft { id: string; policyHash: string; summary: string[] }
interface Status {
	batch: { id: string; state: string; error: string | null; policyHash: string; config: ForemanConfig };
	report: (BatchReport & { stopped?: string | null; baseSha?: string | null; baseSource?: string | null }) | null;
}
interface Params {
	action: "draft" | "launch" | "status" | "stop";
	config?: unknown;
	id?: string;
	cancel?: boolean;
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: truncateText(body).text }], details: undefined });

function normalizeDraftConfig(value: unknown): object {
	if (typeof value === "string") {
		try { value = JSON.parse(value); }
		catch { throw new Error("durable_batch: draft.config must be an object or a JSON string encoding an object."); }
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("durable_batch: draft.config must be an object or a JSON string encoding an object.");
	}
	return value;
}

function batchRoute(id: string | undefined): string {
	if (!id) throw new Error("durable_batch: `id` is required for launch/status/stop.");
	return `/batches/${encodeURIComponent(id)}`;
}

const argv = (parts: readonly string[]) => parts.map((part) => JSON.stringify(part)).join(" ");
const PROMPT_CHARS = 200;

function taskSummary(task: ForemanTask, worker: ForemanConfig["worker"]): string[] {
	return [
		`- ${task.id}${task.dependencies.length ? ` (after ${task.dependencies.join(", ")})` : ""}; owns ${task.ownedFiles.join(", ")}`,
		`  Writer: ${task.model ?? worker.model} (${task.thinking ?? worker.thinking})`,
		`  Reviewer: ${task.reviewModel ?? worker.reviewModel ?? worker.model} (${worker.reviewThinking ?? worker.thinking})`,
		`  Writer fallbacks (ordered): ${task.modelFallbacks?.join(" -> ") || "none"}`,
		`  checks: ${task.checks.map(argv).join("; ")}`,
		`  prompt: ${Array.from(task.prompt.replace(/\s+/g, " ")).slice(0, PROMPT_CHARS).join("")}${task.prompt.length > PROMPT_CHARS ? "…" : ""}`,
	];
}

/** Everything the user approves: targets, limits, and every command and prompt the batch runs. */
function summary(config: ForemanConfig, mode: "run" | "resume"): string[] {
	const { worker, publication, repo, limits } = config;
	return [
		`Batch: ${config.batch.id} (${mode})`,
		`Executor: ${config.executor ?? "local"}`,
		`Repository: ${repo.root}, base branch ${repo.baseBranch}, branches ${repo.branchPrefix}/…`,
		`Worker: ${argv([worker.piExecutable, ...(worker.piPrefixArgs ?? [])])}, model ${worker.model} (${worker.thinking})`,
		`Reviewer: ${worker.reviewModel ?? worker.model} (${worker.reviewThinking ?? worker.thinking})`,
		`Spend allowance: $${config.spend.allowanceUsd} (stopped reviews charge reservations; not a provider cap)`,
		`Deadline: ${limits.deadline}; up to ${limits.maxWorkers} workers, ${limits.maxAttemptsPerTask} attempts per task`,
		`Publication: draft PRs on ${publication.repo} via ${publication.remote} (${publication.url}) with ${publication.gh}; no merges`,
		`Store: ${config.store}; worktrees ${repo.worktreesRoot}; sessions ${repo.sessionsRoot}`,
		`Tasks (${config.batch.tasks.length}):`,
		...config.batch.tasks.flatMap((task) => taskSummary(task, worker)),
	];
}

/** Base SHA/source lines for whichever fields the server report carries. */
const baseFacts = (report: Status["report"]): string[] =>
	([["Base SHA", report?.baseSha], ["Base source", report?.baseSource]] as const)
		.flatMap(([label, value]) => value ? [`${label}: ${value}`] : []);

/** Why this session may not ask for a launch, or undefined when it may. */
function launchRefusal(ctx: ExtensionContext): string | undefined {
	if ((Number.parseInt(process.env.PI_DISPATCH_DEPTH ?? "0", 10) || 0) > 0) return "workers cannot launch batches";
	if (!ctx.hasUI) return "this session has no interactive UI to ask the user";
	return undefined;
}

async function launch(client: ForemanClient, route: string, drafts: Map<string, Draft>, ctx: ExtensionContext): Promise<string> {
	const { batch, report } = await client.request<Status>("GET", route);
	if (!["pending", "stopped"].includes(batch.state)) return `Launch refused: batch ${batch.id} is ${batch.state}.`;
	const cached = drafts.get(batch.id);
	const facts = cached?.policyHash === batch.policyHash ? cached.summary : summary(batch.config, batch.state === "stopped" ? "resume" : "run");
	const approved = await ctx.ui.confirm("Launch durable batch?", [
		...facts, ...baseFacts(report), `Policy hash: ${batch.policyHash}`, "", "Workers run unattended and spend money. Approve?",
	].join("\n"));
	if (!approved) return `Launch declined by the user; nothing started for ${batch.id}.`;
	return JSON.stringify(await client.request("POST", `${route}/approve`, { policyHash: batch.policyHash }));
}

const usd = (value: number | null) => value === null ? "unknown" : `$${value.toFixed(2)}`;

function status({ batch, report }: Status): string {
	const lines = [`Batch ${batch.id}: ${batch.state}`];
	if (batch.error) lines.push(`Error: ${batch.error}`);
	if (!report) return lines.join("\n");
	lines.push(`Phase: ${report.phase}; deadline ${report.deadline}`,
		`Accounted spend: ${usd(report.spentUsd)} of ${usd(report.allowanceUsd)} allowance (not a provider spending cap)`);
	lines.push(...baseFacts(report));
	if (report.stopped) lines.push(`Stopped: ${report.stopped}`);
	lines.push(...report.halted.map((reason) => `Halted: ${reason}`));
	for (const task of report.tasks) {
		const pr = task.pr ? ` PR #${task.pr.number}` : "";
		const reason = task.reason ? ` — ${task.reason}` : "";
		lines.push(`  ${task.state.padEnd(8)} ${task.id} (${task.attempts} attempt${task.attempts === 1 ? "" : "s"}, ${usd(task.spentUsd)})${pr}${reason}`);
	}
	return lines.join("\n");
}

export function registerDurableBatchTool(pi: ExtensionAPI): void {
	const drafts = new Map<string, Draft>();
	pi.on("session_start", () => { drafts.clear(); });
	pi.registerTool({
		name: "durable_batch",
		label: "Durable batch",
		description:
			"Draft an unattended batch on the Foreman coordinator, ask the user to launch it, or check status/stop it. Launch always asks the user to confirm in the Pi UI; the coordinator runs the batch.\n\n" + HETZNER_DRAFT_GUIDANCE,
		promptSnippet: "Draft Foreman batches; launch only with user approval",
		promptGuidelines: [
			"durable_batch: Draft when the user asks for an unattended batch. For 3+ writer tasks on a repository Foreman serves, suggest a durable batch instead of in-session writers so work runs on the executor. Never launch without the user's request. launch shows the batch and asks the user to confirm; the Foreman coordinator runs it. Never say a batch started unless approve returned state approved.",
			"durable_batch: When drafting Foreman tasks for Hetzner, follow the drafting guidance in the durable_batch tool description.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("draft"), Type.Literal("launch"), Type.Literal("status"), Type.Literal("stop")]),
			config: Type.Optional(Type.Any({ description: "draft: full Foreman batch configuration as an object or a JSON string encoding an object (validated by the coordinator)" })),
			id: Type.Optional(Type.String({ description: "launch/status/stop: batch id on the coordinator" })),
			cancel: Type.Optional(Type.Boolean({ description: "stop: also cancel running workers" })),
		}),
		async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx) {
			const refused = params.action === "launch" ? launchRefusal(ctx) : undefined;
			if (refused) return text(`Launch refused: ${refused}. Ask the user to use an interactive Pi session.`);
			try {
				const config = params.action === "draft" ? normalizeDraftConfig(params.config) : undefined;
				const client = new ForemanClient();
				if (params.action === "draft") {
					const draft = await client.request<Draft>("POST", "/batches", config);
					drafts.set(draft.id, draft);
					return text([`Batch: ${draft.id}`, `Policy hash: ${draft.policyHash}`, ...draft.summary].join("\n"));
				}
				const route = batchRoute(params.id);
				if (params.action === "launch") return text(await launch(client, route, drafts, ctx));
				if (params.action === "status") return text(status(await client.request<Status>("GET", route)));
				return text(JSON.stringify(await client.request("POST", `${route}/stop`, { cancel: params.cancel === true })));
			} catch (error) {
				return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
			}
		},
	});
}
