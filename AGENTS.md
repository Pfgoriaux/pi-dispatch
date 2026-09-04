# AGENTS.md

`pi-dispatch` is a pi extension package: a `dispatch` tool that fans work out to
sub-agents with a strict context firewall. Why: agents burn context reading
raw transcripts and step on each other writing — fan-out + isolation + one
distilled report makes multi-agent work cheap enough to do casually in a
coding session, with per-worker observability in Herdr. Design plan:
`docs/plan.md`; spike findings (API quirks that will bite you):
`docs/spikes-phase0.md`.

## Layout conventions

- `src/index.ts` — the only place `pi.*` / tool registration happens.
- `src/agents.ts` — agent discovery (frontmatter markdown).
- `src/worker.ts` — in-process hermetic worker runner (research tier).
- `src/worker-proc.ts` — child-`pi`-process worker runner (write tier).
- `src/worktree.ts` — git worktree lifecycle for write-tier tasks (execFile-only git).
- `src/merge.ts` — worktree branch merge-back loop + merge agent.
- `src/model.ts` — model-runtime sharing (parent registry → worker runtime).
- `src/render.ts` — TUI rendering (pure; no `pi.*` calls).
- `src/panes.ts` — optional Herdr arborescence: one git worktree Space per
  `herdr: true` task (`herdr worktree create`), nested under the master's repo
  row in the Spaces sidebar (`pi-dispatch (master) → scout-1, …`). Herdr allows
  exactly one lifecycle authority per pane, so sub-agents are never reported on
  the master's pane — worktree Spaces are the only nesting primitive. Viewers
  only — never a worker transport; best-effort, no-op outside Herdr, auto-remove
  on success, held open on failure.
- `agents/*.md` — bundled agent definitions, frontmatter format must stay
  byte-compatible with the official pi example (`examples/extensions/subagent`).

## Hard rules

- **Context firewall is the product.** The tool result `content` (model-visible)
  may contain only final worker/aggregator text. Statuses, usage, previews,
  session ids go in `details` (UI-only). Never put worker transcripts in `content`.
- **Every model-visible string goes through `truncateText`** (12KB/task, counted
  as UTF-8 bytes — not `text.length` code units — and never split
  mid-code-point): worker outputs, the aggregated report, aggregator inputs,
  and failure-section error strings. Propagate the `truncated` flag into
  `details.truncated`.
- Never weaken `{previous}` chain interpolation: it must use a replacer function
  (`replaceAll("{previous}", () => previous)`) — plain string replacement
  substitutes `$&`, `$'`, `` $` `` patterns and silently corrupts data.
- Workers must stay hermetic: `noExtensions`, `noSkills`, `noContextFiles`.
  This is the sole recursion guard — do not add resource loading without a
  recursion story, and do not re-add a closure depth counter (it measures
  sibling tool-call concurrency, not nesting, and misfires on parallel dispatches).
- Per-task `cwd` must go through `validateTaskCwd` (session-cwd subtree, realpath
  checked). Don't remove it to "just allow absolute paths".
- `DefaultResourceLoaderOptions.agentDir` is a required string — `getAgentDir()`.
- Blank-response detection: a completed assistant turn with no text at all
  is a failed attempt (error + failover), never "ok with empty output".
- Import `Type` from `@earendil-works/pi-ai` (not a local `typebox` dependency) —
  matches the official example and avoids dual-typebox schema-symbol mismatches.
- Tool name is `dispatch` (distinct from the official example's `subagent`
  so both can be installed).

## Testing

Real-model E2E is the only meaningful test for the pipeline:

```bash
pi -e ./src/index.ts -p --mode json --no-session "Use the dispatch tool in parallel mode with two scout tasks: ... "
```

Parse the `agent_end` event: assert the `toolResult` content is the aggregated text
only, and `details.items[]` has one entry per worker with `status: "ok"`.

## Commands

- `npm install` — no runtime deps (schemas come from `@earendil-works/pi-ai`);
  only needed to (re)generate a lockfile if deps are ever added.
- No build step: pi loads `src/index.ts` via jiti.
