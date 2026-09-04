# pi-dispatch

Hybrid multi-agent dispatch extension for the [pi coding agent](https://github.com/badlogic/pi-mono): one `dispatch` tool fans work out to N parallel sub-agents without blowing up the master's context.

Best practices merged from three sources:
- **[aliou/pi-harness](https://github.com/aliou/pi-harness)** agent-kit — in-process hermetic sub-agents via `createAgentSession()`, strict context firewall, shared model-runtime pattern
- **Official pi example** (`examples/extensions/subagent/`) — `single | parallel | chain` modes, frontmatter agent definitions
- **Herdr orchestration pattern** — fan-out to N diverse agents, then a separate **aggregator agent** distills the raw outputs before anything reaches the master (double firewall)

## How it works

```
master agent
  └─ dispatch({ tasks: [{agent, task} × N] })     # parallel mode
       ├─ worker 1 ┐ each: isolated session, restricted tools,
       ├─ worker 2 ┤        hermetic loader, own sessionId
       ├─ ...      ┘
       └─ aggregator ── distills N reports → ONE text back to master
```

**Context firewall:** the tool-result `content` (model-visible) contains only final worker/aggregator text. Statuses, timings, usage, and per-worker previews live in `details` (UI-only). Worker transcripts never enter the master context.

**Modes:**
- `single` — `{ agent, task }`
- `parallel` — `{ tasks: [{agent, task, cwd?}] }`, max 8 tasks, concurrency 4; results distilled by `aggregator` unless `aggregate: false`
- `chain` — `{ chain: [{agent, task}] }`, sequential; `{previous}` = prior step's output

**Safety:** workers are hermetic (`noExtensions`, `noSkills`, no context files) — they cannot recursively dispatch. Workers default to the parent's active model; per-agent override via frontmatter `model: provider/id`.

## Model rosters

Configure weighted model rosters with automatic failover in `~/.pi/agent/settings/subagent-models.json` (JSON, `<agentName> → array of candidates`). The format is compatible with `aliou/pi-harness` rosters:

```json
{
  "scout": [
    { "provider": "anthropic", "model": "claude-sonnet-4", "thinking": "high", "weight": 2 },
    { "provider": "aperture", "model": "neuralwatt/glm-5.3", "thinking": "off", "weight": 1 }
  ]
}
```

Fields:
- `provider`, `model` — required strings
- `thinking` — optional, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (applied to the worker session)
- `weight` — positive number; candidates are tried in descending weight order

**Resolution order per task:**
1. Roster for `agent.name` (if valid and non-empty)
2. Agent frontmatter `model:` / `thinking:`
3. Inherit fallback (parent's active model, thinking `off`)

**Failover:** dispatch tries candidates in ranked order. A candidate fails when `prompt()` throws, the last assistant message has `stopReason === "error"`, or the turn completes with **no text at all** (blank-response detection — thinking-only or empty finals fail over to the next candidate rather than returning "ok with no output"). On failure the next candidate gets a fresh `createAgentSession` with a shared model runtime per provider. Usage is aggregated across all attempts and reported in `details.items[].usage`.

**Cooldowns:** after a candidate fails, it is skipped for 60 seconds (in-memory, keyed `provider/model`, no disk persistence).

## Write tier (worktrees)

Tasks marked `worktree: true` run the write tier — a child `pi` process per task, isolated inside its own git worktree:

```
master agent
 └─ dispatch({ tasks: [{agent: "writer", task, worktree: true} × N] })
      ├─ git worktree add .dispatch/worktrees/t1 -b dispatch/<runId>/t1
      ├─ child pi #1 (cwd = worktree 1) ─ commits on its branch
      ├─ child pi #2 (cwd = worktree 2) ─ commits on its branch
      └─ after ALL finish: sequential `git merge --no-edit` per branch,
         conflict → merge agent (bash/read/edit) resolves preserving BOTH
         sides, then worktrees removed (branches deleted after a clean merge)
```

- **Requires** a committed-clean git repo root (`git status --porcelain` empty) and the session cwd to be the repo root; per-task `cwd` is not allowed for worktree tasks.
- `.dispatch/` is added to `.gitignore` on first use (commit it). Stale `.dispatch/worktrees/*` entries (missing branch or >24h old) are GC'd at dispatch start.
- Child pi runs `pi -p --no-session --mode json` with the agent's system prompt (`--system-prompt`), tool allowlist (`--tools`, or `--no-tools` for `tools: none`), `--exclude-tools dispatch` (recursion backstop) and `PI_DISPATCH_DEPTH=<parent+1>` (max depth 2).
- Workers' commit summaries (not diffs) return through the same context firewall and aggregator as the research tier.
- On abort, workers get SIGTERM (SIGKILL after 5s), worktrees are removed, branches are **kept** for a human. Merge failures keep the branch and `git merge --abort`s the attempt — `details.merges` (UI-only) reports which branches failed and why.
- Fresh worktrees don't contain gitignored build deps (`node_modules/` etc.) — tasks that need builds should install or be scoped to source edits.
- Chain mode supports `worktree: true` per step; each step's branch merges before the next step runs.

## Agents

Frontmatter markdown, byte-compatible with the official example. Discovery: bundled (`agents/`) < user (`~/.pi/agent/agents/`) < project (`.pi/agents/`, trusted projects only).

Bundled: `scout` (read-only recon), `reviewer` (code review), `planner` (implementation plans), `aggregator` (fan-in specialist, no tools), `writer` (worktree write tier — implements, commits, and reports a summary).

## Install

Local development (dogfood inside this repo — `.pi/settings.json` is committed):

```bash
npm install
pi -p "dispatch two scouts …"
```

Global: add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["~/path/to/pi-dispatch"] }
```

Or from a git remote once published: `pi install git:github.com/<you>/pi-dispatch`.

Requires pi ≥ 0.84 (exported `createAgentSession`, `DefaultResourceLoader.noExtensions`, `parseFrontmatter`, `getAgentDir`).

## Status

- [x] Phase 0 — spikes (see `docs/spikes-phase0.md`): concurrent in-process workers, hermetic loaders, abort/partial results
- [x] Phase 1 — MVP: dispatch tool, modes, frontmatter agents, rendering, abort propagation
- [x] Phase 2 — aggregator double firewall + weighted model rosters with failover/cooldowns
- [x] Phase 3 — write tier (child `pi` processes in git worktrees + merge agent)
- [x] Phase 4 — Herdr observability (env-gated notifications), resumable worker sessions (opt-in), packaging

See also: "Model rosters", "Write tier (worktrees)", and "Resumable sessions & Herdr observability" below.

Full plan: `docs/plan.md`.

## Resumable sessions & Herdr observability

**Persist + resume (opt-in):** `dispatch({ ..., persist: true })` stores worker
sessions under `~/.pi/agent/pi-dispatch/sessions` (indexed in `index.json`).
The tool result lists the persisted sessionIds; continue any of them with full
worker context via `dispatch({ resume: "<sessionId>", task: "continue..." })`.
Workers without `persist` stay in-memory exactly as before.

**Herdr:** when pi-dispatch runs inside a Herdr-managed pane (`HERDR_ENV=1`),
every completed dispatch fires a native notification (ok/failed counts,
duration, aggregation status). No-op everywhere else, and best-effort — never
blocks or fails a dispatch.

**Herdr arborescence:** tasks flagged `herdr: true` each get a git worktree
Space (`herdr worktree create`) that nests under the parent repo row in the
Spaces sidebar — a live `tail` of that worker's pretty log, state reported
per worker, auto-removed on success and held open with the error on failure.
Herdr allows exactly one lifecycle authority per pane, so a sub-agent can
never be reported on the master's own pane; worktree Spaces are the only
nesting primitive.

## Acknowledgments

The sub-agent model roster semantics — `settings/subagent-models.json`,
weighted draw, pre-first-token failover, provider cooldowns — are compatible
with [aliou/pi-harness](https://github.com/aliou/pi-harness) by design, so
both harnesses share one roster config file. Cross-checked against his
implementation while building this.


## The pi extension family

Five packages, one workflow: plan, fan out, review, protect, verify.

| Package | Job |
|---|---|
| [pi-dispatch](https://github.com/Pfgoriaux/pi-dispatch) | parallel sub-agent fan-out, merge-back, Herdr arborescence |
| [pi-feature-swarm](https://github.com/Pfgoriaux/pi-feature-swarm) | read-only multi-model feature discovery & planning |
| [pi-pr-swarm](https://github.com/Pfgoriaux/pi-pr-swarm) | multi-model PR review, then aggregate & fix |
| [pi-worktree-guard](https://github.com/Pfgoriaux/pi-worktree-guard) | one branch = one worktree = one agent |
| [pi-repo-check](https://github.com/Pfgoriaux/pi-repo-check) | repo hygiene gate: conventions, docs-in-pairs, baseline |
