/** Shared UI-only worker lifecycle for dispatch and its workflow tools. */
import { DispatchPanes } from "./panes.ts";
import { DispatchSpaces, type SpaceWorker } from "./spaces.ts";
import type { DispatchDetails, WorkerActivity, WorkerResult } from "./types.ts";

interface PlannedTask {
	agent: string;
	task: string;
	herdr?: boolean;
}
type Update = (update: {
	content: { type: "text"; text: string }[];
	details: DispatchDetails;
}) => void;

export class DispatchProgress {
	private activity: WorkerActivity[];
	private results = new Map<number, WorkerResult>();
	private starts = new Map<number, number>();
	private warnings: string[] = [];
	private panes: DispatchPanes | null = null;
	private spaces: DispatchSpaces | null = null;
	private lastEmit = 0;

	constructor(
		private mode: DispatchDetails["mode"],
		private tasks: PlannedTask[],
		private update?: Update,
	) {
		this.activity = tasks.map((item, index) => ({
			...item,
			index,
			status: "queued",
			attempts: 0,
			ms: 0,
		}));
		this.emit(true);
	}

	private spaceWorkers(): SpaceWorker[] {
		return this.activity.filter((row) => this.tasks[row.index].herdr !== false)
			.map(({ index, agent, status, model, attempts }) => ({ index, agent, status, model, attempts }));
	}

	async open(cwd: string, signal?: AbortSignal): Promise<void> {
		const warn = (warning: string) => {
			if (!this.warnings.includes(warning)) this.warnings.push(warning);
			this.emit(true);
		};
		this.spaces = await DispatchSpaces.create(this.spaceWorkers(), warn, signal);
		this.panes = await DispatchPanes.create(
			this.tasks
				.map((task, index) => ({ ...task, index }))
				.filter((task) => task.herdr !== false),
			cwd,
			`dispatch ${this.mode}`,
			warn,
			signal,
		);
	}

	start(index: number): void {
		const row = this.activity[index];
		if (!row) return;
		this.starts.set(index, Date.now());
		row.status = "running";
		this.panes?.start(index);
		void this.spaces?.update(this.spaceWorkers());
		this.emit(true);
	}

	options(index: number) {
		return {
			onWarning: (warning: string) => {
				if (!this.warnings.includes(warning)) this.warnings.push(warning);
				this.emit(true);
			},
			onBoundary: () => this.emit(),
			onStream: this.panes?.streamer(index),
			onAttempt: (model: string, thinking: string, attempt: number) => {
				const row = this.activity[index];
				if (!row) return;
				Object.assign(row, {
					model,
					thinking,
					attempts: attempt,
					status: "running",
				});
				this.panes?.start(index, `${model} · ${thinking} · attempt ${attempt}`);
				void this.spaces?.update(this.spaceWorkers());
				this.emit(true);
			},
		};
	}

	async run(
		index: number,
		work: () => Promise<WorkerResult>,
		signal?: AbortSignal,
	): Promise<WorkerResult> {
		this.start(index);
		let result: WorkerResult;
		try {
			result = await work();
		} catch (error) {
			const row = this.activity[index];
			result = {
				agent: this.tasks[index].agent,
				task: this.tasks[index].task,
				status: signal?.aborted ? "aborted" : "error",
				text: "",
				error: String(error),
				model: row?.model,
				thinking: row?.thinking,
				attempts: row?.attempts ?? 0,
				ms: Date.now() - (this.starts.get(index) ?? Date.now()),
			};
		}
		await this.finish(index, result);
		return result;
	}

	async finish(index: number, result: WorkerResult): Promise<void> {
		this.results.set(index, result);
		const row = this.activity[index];
		if (row) Object.assign(row, result, { model: result.model ?? row.model });
		this.emit(true);
		await Promise.all([
			this.spaces?.update(this.spaceWorkers()),
			this.panes?.finish(index, result),
		]);
	}

	emit(force = false): void {
		if (!this.update || (!force && Date.now() - this.lastEmit < 1000)) return;
		this.lastEmit = Date.now();
		const done = this.results.size;
		this.update({
			content: [
				{
					type: "text",
					text: `dispatch ${this.mode}: ${done}/${this.tasks.length} workers done`,
				},
			],
			details: {
				mode: this.mode,
				items: [...this.results.entries()]
					.sort(([a], [b]) => a - b)
					.map(([, result]) => result),
				activity: this.activity.map((row) => ({
					...row,
					ms:
						row.status === "running"
							? Date.now() - (this.starts.get(row.index) ?? Date.now())
							: row.ms,
				})),
				warnings: [...this.warnings],
				aggregated: false,
				truncated: false,
				running: true,
				total: this.tasks.length,
			},
		});
	}

	async end(): Promise<void> {
		await Promise.all([this.spaces?.end(), this.panes?.end()]);
	}
}
