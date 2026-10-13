import { GLM_MODEL, KIMI_MODEL } from "../profiles.ts";

export const HETZNER_TASK_PROMPT_TEMPLATE = `## Goal
<One or two sentences stating the outcome.>
## Context
<What exists today; exact file paths and symbols to read first.>
## Change
1. <Concrete change with exact identifiers and paths.>
2. <Next concrete change; omit if unnecessary.>
## Contracts
<Exact names, signatures, types, and data shapes to produce or keep.>
## Do not
<Explicit non-goals and files not to touch.>
## Checks
<Exact commands matching this task's checks argv; commands run without a shell.>
## Commit
<The exact Conventional Commit message.>
## Report
<Output files changed, commands run with results, and anything left undone.>`;

export const HETZNER_MODEL_GUIDANCE = `| Executor contract | Task model | Task reviewModel | Task modelFallbacks |
|---|---|---|---|
| \`long\`: frontend and UI, design systems, data visualization, image inputs, end-to-end feature builds | \`${KIMI_MODEL}\` | \`${GLM_MODEL}\` | None |
| GLM: backend changes, refactors and code migrations, bug fixes, scripts and infra, terminal-heavy work | \`${GLM_MODEL}\` | \`${KIMI_MODEL}\` | None |
| \`precise\` | Keep local; do not draft for Hetzner | — | — |
GLM 5.3 takes text only; a task that needs an image goes to Kimi.
Foreman runs Kimi K3 and GLM 5.3 on Neuralwatt or Synthetic by provider quota and retries the other route after a provider refusal without using an attempt. Do not list the other route as a fallback.
Writer and reviewer thinking must be \`high\` or above: set worker.thinking, and any worker.reviewThinking, task thinking, or task reviewThinking, to \`high\` (default), \`xhigh\`, or \`max\`. durable_batch refuses lower effort before drafting.
Use these literal defaults, not environment-overridden PROFILES or REVIEW_MODELS. This is drafting guidance, not automatic configuration rewriting, provider validation, or routing.`;

export const HETZNER_DRAFT_GUIDANCE = [
	"When drafting Foreman tasks for Hetzner, use the following model mapping:",
	HETZNER_MODEL_GUIDANCE,
	"Partition by one concern per task. Keep ownedFiles small and bounded: exact files or narrow directories. Independent tasks use dependencies: [] so they run in parallel. Express real ordering only through dependencies.",
	"No task may require a product or design decision. Keep unresolved decisions in planning and take them to the user before drafting executable tasks. Precise-tier work stays local; never draft it for Hetzner.",
	"Hetzner workers see only their task prompt, not the plan or this conversation. Make each prompt fully self-contained. Use plain, literal language, exact identifiers and paths. Do not refer to the plan, other tasks' internals, or the conversation; never use 'as discussed'. Include required shared contracts directly.",
	"Keep the template headings in order and replace all placeholders with concrete task facts; Checks must match that task's checks argv. Each Hetzner task `prompt` must use this template (these headings are for the task prompt, not for your own output):\n```markdown\n" +
		HETZNER_TASK_PROMPT_TEMPLATE + "\n```",
].join("\n\n");

export interface PlanContext {
	cwd: string;
	idea: string;
	focus: string;
}

function header(c: PlanContext, goal: string): string[] {
	const lines = [
		goal,
		"Read applicable AGENTS.md instructions first; do not modify the repository.",
		"If an input report is truncated, read its saved file completely with offset/limit before using it.",
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
	];
	if (c.focus) lines.push("", `FOCUS / scope hint from the user: "${c.focus}". Explore there first.`);
	return lines;
}

export function architectDraftTask(c: PlanContext): string {
	return [
		...header(c, "You are the architect for this feature. Discover the relevant code, then design the implementation."),
		"",
		"Scale detail to the feature. A small feature usually needs one or two implementation tasks; larger features may need more.",
		"Reference repository instructions and source paths instead of repeating their contents. Include only decisions and context workers cannot rediscover safely.",
		HETZNER_DRAFT_GUIDANCE,
		"Return a concise draft design (Markdown; omit empty sections):",
		"## Goal",
		"## Scope (in, out, and what stays unchanged)",
		"## Current state (relevant files and flows, with paths)",
		"## Architecture (boundaries, interfaces, data changes, invariants)",
		"## Draft tasks (owned files, behavior, dependencies)",
		"## Risks and unknowns",
		"## Product decisions needed (only choices the code cannot answer)",
	].join("\n");
}

export function preMortemTask(c: PlanContext, draft: string): string {
	return [
		...header(c, "Run a pre-mortem on this feature design."),
		"",
		"DRAFT DESIGN:",
		draft,
		"",
		"Question: this feature shipped as designed. Three months later it broke. What is the most likely reason?",
		"Start with the draft design. Inspect files it proposes to change, their direct callers and dependencies, and relevant tests.",
		"Do not audit the whole repository. Expand beyond that scope only to investigate a concrete risk identified in the draft or those files.",
		"",
		"Return at most 3 likely failures, ranked by likelihood, under 30 lines total.",
		"For each: state the failure, cite the draft section and supporting code paths/lines where available, and suggest a concrete preventive design change or check.",
		"If no risk is supported by the draft or code, return \"None\". Do not fill the quota with speculative risks.",
	].join("\n");
}

export function challengerTask(c: PlanContext, draft: string, preMortem: string): string {
	return [
		...header(c, "Challenge this feature design. You are an independent reviewer, not its author."),
		"",
		"DRAFT DESIGN:",
		draft,
		"",
		"PRE-MORTEM (verify its claims against the code):",
		preMortem,
		"",
		"Check the design against the actual code. Look for wrong assumptions, missing failure paths, migration and compatibility risks,",
		"interface contracts that workers could misread, and a simpler approach that meets the same goal.",
		"Report only issues that would cause incorrect behavior, rework, or a failed check.",
		"",
		"Return (under ~120 lines):",
		"## Verdict (sound / sound with changes / rethink)",
		"## Issues (each: problem, evidence path, required change)",
		"## Pre-mortem assessment (confirmed, rejected, or adjusted, with evidence)",
		"## Simpler alternative (only if it meets the same goal)",
	].join("\n");
}

const TASK_CONTRACT = [
	"### Task N: <title>",
	`- Executor: exactly one of \`long\` (frontend and UI, design, data visualization, image inputs, end-to-end feature builds), \`${GLM_MODEL}\` (backend changes, refactors and code migrations, bug fixes, scripts and infra, terminal-heavy work), or \`precise\` (auth, migrations touching data, concurrency, shared interfaces)`,
	"- Thinking: exactly one of `high` (default), `xhigh` (complex, auth, migrations, concurrency, review), or `max` (explicit, exceptionally hard)",
	"- Executor reason: <only required for `precise`>",
	"- Repository: <repo root the task runs in>",
	"- Source pointers: <only essential paths the worker would otherwise miss; omit if none>",
	"- Depends on: <task numbers or none>",
	"- Owns: <exact file paths>",
	"- Behavior: <observable behavior to implement>",
	"- Contracts: <interfaces, data shapes, and invariants to keep>",
	"- Verify: <tests and checks that prove it works>",
	"- Escalate when: <only non-obvious boundaries requiring a decision; omit if none>",
];

export function architectFinalTask(c: PlanContext, draft: string, preMortem: string, challenge: string): string {
	return [
		...header(c, "You are the architect. Finalize your design into an execution plan."),
		"",
		"YOUR DRAFT DESIGN:",
		draft,
		"",
		"PRE-MORTEM:",
		preMortem,
		"",
		"DESIGN CHALLENGE:",
		challenge,
		"",
		"Resolve every challenge issue: accept it and change the design, or reject it with evidence. Verify disputed claims in the code.",
		"Workers have repository access but not this conversation. Each contract must carry the outcome, ownership, dependencies, non-obvious decisions, shared interfaces, and acceptance checks needed to execute it.",
		"Local implementation workers run child pi sessions that load project context normally. Do not repeat AGENTS.md instructions or reminders in task contracts; name nested instruction files only when workers would otherwise miss them. Omit copied files, routine steps, and discovery transcripts.",
		HETZNER_DRAFT_GUIDANCE,
		"Scale plan length to scope, not a fixed word limit. Small features usually need one or two short implementation contracts; large features may need more coordination detail.",
		"Split tasks only for meaningful ownership or dependencies. Keep routine checkout preparation, documentation, and final checks with the coordinator or an implementation task, not separate workers.",
		"Pass each contract’s Thinking through as the dispatch task thinking field, or the Foreman task thinking field for Hetzner drafts, independent of Executor.",
		"Local tasks in one dispatch call share one repository and feature checkout; different repositories need separate calls.",
		"Keep independent tasks separate so they can run in parallel; order dependent tasks. Put exact shared interfaces in the contracts that need them without repeating a separate architecture section.",
		"Answer technical questions yourself. Ask the human only about product decisions the code cannot answer.",
		"",
		"Return the following Markdown, omitting empty or redundant sections.",
		"",
		"# Feature plan: <short title>",
		"## Goal",
		"## Decisions for you",
		"Write \"None\" if empty; for each: the question, Options: A) … B) …, Recommended: <letter> — <why>, and the tasks it changes.",
		"## Scope (in, out, unchanged)",
		"## Execution tasks",
		...TASK_CONTRACT,
		"## Final verification (checks and observable behavior after all tasks)",
		"## Challenge resolution (only rejected or unresolved findings needing explanation; accepted fixes belong in contracts)",
	].join("\n");
}
