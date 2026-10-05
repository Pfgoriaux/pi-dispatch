import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { herdrCommand, herdrEnabled, type WatchedAgent } from "./herdr.ts";

const ENTRY = "dispatch-herdr-watches";
const NOTICE = "dispatch-herdr-ready";
const MAX_WATCHES = 16;

export interface Watch {
	id: string;
	target: string;
	identity: string;
	failures: number;
}

interface Caller { pane: string; workspace: string; socket: string }

async function getCaller(): Promise<Caller> {
	const { pane } = await herdrCommand(["pane", "current", "--current"]);
	if (!pane?.pane_id || !pane.workspace_id || !process.env.HERDR_SOCKET_PATH) {
		throw new Error("Herdr caller identity is unavailable.");
	}
	return { pane: pane.pane_id, workspace: pane.workspace_id, socket: process.env.HERDR_SOCKET_PATH };
}

function identity(agent: WatchedAgent): string {
	if (!agent.agent_session?.value) throw new Error("Herdr has no stable session identity for this worker.");
	return JSON.stringify([agent.terminal_id, agent.agent, agent.agent_session.kind, agent.agent_session.value]);
}

export async function getHerdrAgent(target: string): Promise<WatchedAgent> {
	if (/^-|[\s\x00]/.test(target)) throw new Error("Invalid Herdr worker target.");
	const response = await herdrCommand(["agent", "get", target]);
	const agent = response.agent;
	if (!agent?.pane_id || !agent.workspace_id || !agent.terminal_id || !agent.agent_status) {
		throw new Error("Herdr returned no agent identity or state.");
	}
	return agent;
}

/** One-shot watches: each resumed worker turn must be registered again. */
export class HerdrWatcher {
	private watches = new Map<string, Watch>();
	private epoch = 0;
	private polling = false;
	private queued = new Set<string>();

	constructor(
		private readonly get: (target: string) => Promise<WatchedAgent>,
		private readonly save: (watches: Watch[]) => void,
		private readonly notify: (lines: string[], ids: string[]) => void,
	) {}

	list(): Watch[] {
		return [...this.watches.values()].map(watch => ({ ...watch }));
	}

	reset(watches: Watch[] = []): void {
		this.epoch++;
		this.queued.clear();
		this.watches = new Map(watches.map(watch => [watch.target, { ...watch }]));
	}

	async add(targets: string[], workspace: string, self: string, signal?: AbortSignal): Promise<void> {
		const epoch = this.epoch;
		const agents = await Promise.all(targets.map(target => this.get(target)));
		if (signal?.aborted) throw new Error("Watch registration cancelled.");
		const additions = agents.map(agent => {
			if (agent.workspace_id !== workspace) throw new Error("Watch only workers in the caller's workspace.");
			if (agent.pane_id === self) throw new Error("Cannot watch the coordinator itself.");
			return { id: randomUUID(), target: agent.pane_id, identity: identity(agent), failures: 0 };
		});
		if (epoch !== this.epoch) throw new Error("Coordinator session changed; register workers again.");
		const next = new Map(this.watches);
		for (const watch of additions) next.set(watch.target, watch);
		if (next.size > MAX_WATCHES) throw new Error(`At most ${MAX_WATCHES} workers can be watched.`);
		this.watches = next;
		this.save(this.list());
	}

	clear(): void {
		const hadWatches = this.watches.size > 0;
		this.reset();
		if (hadWatches) this.save([]);
	}

	acknowledge(ids: string[]): void {
		const before = this.watches.size;
		const delivered = new Set(ids);
		for (const watch of this.watches.values()) {
			if (!delivered.has(watch.id)) continue;
			this.watches.delete(watch.target);
			this.queued.delete(watch.id);
		}
		if (this.watches.size !== before) this.save(this.list());
	}

	async poll(retryUndelivered = false): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		const epoch = this.epoch;
		const pending = [...this.watches.values()].filter(watch => retryUndelivered || !this.queued.has(watch.id));
		try {
			const results = await Promise.allSettled(pending.map(watch => this.get(watch.target)));
			if (epoch !== this.epoch) return;
			const ready: Watch[] = [];
			const lines: string[] = [];
			for (const [index, result] of results.entries()) {
				const watch = pending[index];
				if (this.watches.get(watch.target) !== watch) continue;
				const reason = this.reason(watch, result);
				if (!reason) continue;
				ready.push(watch);
				lines.push(`${watch.target}: ${reason}`);
			}
			if (!ready.length) return;
			const ids = ready.map(watch => watch.id);
			for (const id of ids) this.queued.add(id);
			try {
				this.notify(lines, ids);
			} catch (error) {
				for (const id of ids) this.queued.delete(id);
				throw error;
			}
			// Removal happens only when Pi emits the custom message's message_end.
		} finally {
			this.polling = false;
		}
	}

	private reason(watch: Watch, result: PromiseSettledResult<WatchedAgent>): string | undefined {
		if (result.status === "rejected") {
			watch.failures++;
			return watch.failures >= 3 ? "could not inspect worker after three checks; inspect it manually." : undefined;
		}
		const agent = result.value;
		if (!agent.agent_session?.value) return "worker identity is unavailable; inspect it before sending anything.";
		if (identity(agent) !== watch.identity) return "pane now hosts a different session; do not send the old task to it.";
		if (!["working", "idle", "done", "blocked"].includes(agent.agent_status)) {
			watch.failures++;
			return watch.failures >= 3 ? "state remained unknown for three checks; inspect it manually." : undefined;
		}
		watch.failures = 0;
		if (agent.agent_status === "working") return undefined;
		return `worker is ${agent.agent_status}; read its response. This is not proof the task succeeded.`;
	}
}

export function registerHerdrWatch(pi: ExtensionAPI, getAgent = getHerdrAgent, caller = getCaller): void {
	if (!herdrEnabled()) return;
	let context: ExtensionContext | undefined;
	let scope: Caller | undefined;
	let warned = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const watcher = new HerdrWatcher(
		getAgent,
		watches => pi.appendEntry(ENTRY, {
			owner: context?.sessionManager.getSessionId(), scope, watches,
		}),
		(lines, ids) => pi.sendMessage({
			customType: NOTICE,
			content: "Herdr worker update:\n" + lines.join("\n") +
				"\nRead each worker's response with herdr agent read. Resolve questions within the user's existing authorization; " +
				"ask the user for permissions you do not have. After prompting a worker to continue, register it again with herdr_watch. " +
				"These watches have now ended. Do not equate idle/done with successful completion.",
			display: true,
			details: { ids },
		}, { triggerTurn: true, deliverAs: "followUp" }),
	);
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		watcher.reset();
		context = undefined;
		scope = undefined;
		warned = false;
	};
	const schedule = () => {
		if (!context || timer || !watcher.list().length) return;
		const scheduled = setTimeout(async () => {
			try {
				// Queued custom messages can be cleared by Esc. Retry unacknowledged
				// notices only once the coordinator is idle, never every busy tick.
				await watcher.poll(context?.isIdle() === true);
				warned = false;
			} catch {
				if (!warned) context?.ui.notify("Herdr watcher could not deliver an update; will retry.", "warning");
				warned = true;
			} finally {
				if (timer === scheduled) {
					timer = undefined;
					schedule();
				}
			}
		}, 3000);
		timer = scheduled;
		timer.unref();
	};
	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (!["tui", "rpc"].includes(ctx.mode)) return;
		context = ctx;
		const saved = ctx.sessionManager.getBranch().filter(entry =>
			entry.type === "custom" && entry.customType === ENTRY,
		).at(-1);
		if (saved?.type !== "custom") return;
		const data = saved.data as { owner?: string; scope?: Caller; watches?: Watch[] } | undefined;
		if (data?.owner !== ctx.sessionManager.getSessionId()) return;
		if (!Array.isArray(data.watches)) return;
		if (!data.watches.length) return;
		const current = await caller();
		if (context !== ctx) return;
		if (data.scope?.socket !== current.socket || data.scope.workspace !== current.workspace) return;
		scope = current;
		watcher.reset(data.watches.filter(watch =>
			watch && typeof watch.id === "string" && typeof watch.target === "string" && typeof watch.identity === "string",
		).slice(0, MAX_WATCHES).map(watch => ({ ...watch, failures: 0 })));
		schedule();
	});
	pi.on("message_end", event => {
		if (event.message.role !== "custom" || event.message.customType !== NOTICE) return;
		const ids = (event.message.details as { ids?: unknown } | undefined)?.ids;
		if (!Array.isArray(ids)) return;
		watcher.acknowledge(ids.filter((id): id is string => typeof id === "string"));
	});
	pi.on("session_shutdown", stop);
	// Tree navigation can abandon the branch that authorized the watches.
	pi.on("session_tree", () => { watcher.clear(); });
	pi.registerTool({
		name: "herdr_watch",
		label: "Watch Herdr workers",
		description: "Watch explicitly delegated Herdr workers. A settled/blocked worker wakes this coordinator; busy coordinators receive a follow-up. One-shot: register again after each continuation.",
		promptGuidelines: [
			"After successfully prompting standalone Herdr workers, call herdr_watch with their names or pane IDs before ending your turn. Dispatch workers already return through dispatch.",
			"Read worker output when notified: idle/done is not task success. Resolve authorized scope questions, escalate user-only approvals, and re-register each worker you resume.",
			"If herdr_watch is unavailable or registration fails, keep a bounded herdr agent wait/read loop active; do not leave workers unmonitored.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("watch"), Type.Literal("list"), Type.Literal("clear")]),
			targets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_WATCHES })),
		}),
		async execute(_id, args, signal, _update, ctx) {
			if (!["tui", "rpc"].includes(ctx.mode)) throw new Error("Herdr watches require a persistent TUI or RPC coordinator, not print mode.");
			if (signal?.aborted) throw new Error("Watch registration cancelled.");
			if (!herdrEnabled()) throw new Error("Herdr is not enabled.");
			context = ctx;
			if (args.action === "clear") watcher.clear();
			if (args.action === "watch") {
				if (!args.targets?.length) throw new Error("Provide the workers to watch.");
				const current = await caller();
				if (context !== ctx) throw new Error("Coordinator session changed.");
				scope = current;
				await watcher.add(args.targets, current.workspace, current.pane, signal);
				schedule();
			}
			const watches = watcher.list();
			return {
				content: [{ type: "text", text: watches.length
					? `Watching ${watches.map(watch => watch.target).join(", ")}. You will receive a follow-up when a worker settles or needs attention.`
					: "No Herdr workers are being watched." }],
				details: { watches },
			};
		},
	});
}
