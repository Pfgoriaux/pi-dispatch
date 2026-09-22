# pi-dispatch

Hybrid multi-agent dispatch extension for the [pi coding agent](https://github.com/badlogic/pi-mono): one `dispatch` tool fans work out to N parallel sub-agents without blowing up the master's context — plus two workflow tools built on the same engine: `pr_review` and `feature_plan` (both consolidated here from the retired pi-pr-swarm and pi-feature-swarm packages).

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

**Result boundary:** model-visible `content` contains final reports, failure summaries,
and session-ID footers for `persist`/`resume`. Status, usage, and worker previews
live in `details` (UI-only). Raw worker transcripts are not returned to the parent.

**Modes:**
- `single` — `{ agent, task }`
- `parallel` — `{ tasks: [{agent, task, cwd?}] }`, max 8 tasks, concurrency 4; results distilled by `aggregator` unless `aggregate: false`
- `chain` — `{ chain: [{agent, task}] }`, sequential; `{previous}` = prior step's output

## pr_review

"Review a PR" without leaving dispatch. Resolves the diff (GitHub PR number
via `gh`, a git rev-range, a branch vs HEAD, or default `<origin/base>...HEAD`),
then runs three in-process reviewers in parallel:

- `security-reviewer` on the `precise` tier (uses an operator-installed `deepsec` executable outside the checkout, manual review otherwise; repository-local scanners are never selected automatically)
- two `reviewer` passes on the `DIVERSE_PAIR` (separate contexts, different model families: GLM 5.3 and Kimi-K3, both Neuralwatt through Aperture with Synthetic failover)

The `aggregator` distills the findings into one prioritized report, and when
`fix: true` is explicitly requested, a `writer` fixes the findings in a git
worktree whose branch merges back automatically. Unlike the old swarm this
needs no Herdr; the fix step requires a trusted, committed-clean repo root at the
session cwd and authorization for commits and automatic merge-back. `fix` defaults
to **false**. Invalid diffs fail before reviewers start; empty diffs skip model calls.
Fixes require the reviewed head to match the checkout; the checkout is rechecked
before writing and merging so findings cannot silently target another revision.

## feature_plan

"What would implementing X entail?" — two independent architecture scouts
(on the same `DIVERSE_PAIR`: `aperture/neuralwatt/glm-5.3` and
`aperture/neuralwatt/kimi-k3`, both failing over to their Synthetic counterparts)
explore the repository from
the technical-risk lens, then the `planner` agent reconciles both reports into
one implementation plan (goal, scope, file-level where, work breakdown, test
strategy, risks, disagreements, open questions). Read-only, no Herdr needed.

**Isolation:** in-process workers disable extension discovery, skills, and context files.
Every worker also gets Linkup search/answer/fetch when configured; only those tool
entrypoints are added, not unrelated extensions (see below).
Write-tier child processes use different loading behavior and exclude `dispatch`.
Neither a cwd check nor a worktree is a filesystem sandbox; agents with `bash`
can access paths outside their starting directory. In-process tasks must include
applicable constraints or tell workers which instruction files to read.

The bundled scout and planner have no write or shell tools; the reviewer has
`bash` and is read-only by instruction, not enforcement. Models resolve through
rosters, agent frontmatter, then the parent's active model as described below.
Single mode always runs in-process, even when the agent is named `writer`.

## In-process model rosters

Configure ranked model rosters with automatic failover in
`~/.pi/agent/settings/subagent-models.json` (JSON, `<agentName> → array of candidates`).
The file shape accepts `aliou/pi-harness`-style roster entries; selection semantics
here are deterministic ranking, not weighted random sampling:

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

**Resolution order per in-process task:**
1. Roster for `agent.name` (if valid and non-empty)
2. Agent frontmatter `model:` / `thinking:` — `model:` may name an effort tier
   (`cheap` / `balanced` / `precise` / `long`), expanded to a concrete model spec
   plus tier thinking default by `src/profiles.ts` (overridable with
   `DISPATCH_PROFILE_<TIER>_MODEL`); explicit `provider/id` specs and `inherit`
   keep their existing meaning
3. Inherit fallback (parent's active model, thinking `off`)

**Failover:** dispatch tries candidates in ranked order. A candidate fails when `prompt()` throws, the last assistant message has `stopReason === "error"`, or the turn completes with **no text at all** (blank-response detection — thinking-only or empty finals fail over to the next candidate rather than returning "ok with no output"). On failure the next candidate gets a fresh `createAgentSession` with a shared model runtime per provider. Usage is aggregated across all attempts and reported in `details.items[].usage`.

Known Neuralwatt and Synthetic models retry **in either direction**, keeping
the requested provider first. Both direct and `aperture/` specs are recognized;
inserted counterpart routes use Aperture. The pairs are `kimi-k3` ↔
`synthetic/hf:moonshotai/Kimi-K3` and `glm-5.3-flash` ↔
`synthetic/hf:zai-org/GLM-5.3-Flash`. Neuralwatt's non-flash `glm-5.3` also
substitutes Synthetic Flash, since Synthetic carries only that variant.
After provider routes are exhausted, **`openai-codex/gpt-5.6-terra`** is tried
once, last, using Codex subscription authentication rather than the billed
OpenAI API. Unmapped IDs (including `deepseek-v4.1-flash`) are unchanged.

This applies to in-process rosters, frontmatter, explicit overrides, and
inherited models. Write-tier children use the same fallback chain for startup
failures, but stop retrying once any tool has executed: replaying a fresh writer
could duplicate side effects. Thinking is preserved; target routes must be
registered/authenticated in Pi. Duplicate routes are tried once, cancellation
never triggers fallback, and exhaustion returns the last error. Unresolved
fallback entries do not hide the last provider error or mislabel its model.
PR review reports identify the actual model and flag when both code reviewers
land on the same model: independent runs are not a cross-model review.

**Failed-tool loop cutoff (in-process):** an attempt stops after 3 consecutive
calls to unavailable tools, or 5 consecutive tool errors without a successful
result. It becomes a failed attempt, not a user cancellation: existing candidate
failover applies, and workflows can proceed with a successful sibling's report.
Explicit models do not gain arbitrary cross-model fallbacks. User cancellation
still wins and never triggers another attempt. Valid results reset the counters.
This bounds repeated tool failures, not total runtime or successful-tool loops.

Viewer tool completions show `[ok]` or `[error]` in both tiers. Unregistered tool
names are redacted because malformed names may contain arguments or private paths;
raw tool results remain inside the worker. Names are never silently repaired.
Write-tier child processes get these log improvements but not the in-process
cutoff. Uncommitted worktrees are retained for recovery rather than force-deleted.

**Cooldowns:** after a candidate fails, it is skipped for 60 seconds (in-memory,
keyed `provider/model`, no disk persistence).

Write-tier children do not use this roster/failover path. They receive the task's
model override or agent frontmatter model, falling back to the parent for
`inherit`. Thinking comes from the task's tier or agent frontmatter and is
forwarded through `--thinking`.

## Web research with Linkup

Every spawned agent gets `linkup_web_search`, `linkup_web_answer`, and
`linkup_web_fetch` automatically when Linkup is configured. No special agent,
frontmatter opt-in, or dispatch flag is needed. The role's `tools:` list still
controls local tools; even `tools: none` roles can use web tools. Agents decide
whether research is needed rather than searching on every task.

Workers use the installed `@aliou/pi-linkup` package (tested with 0.11.0):

- Install globally with `pi install npm:@aliou/pi-linkup` and provide
  `LINKUP_API_KEY` in the Pi process environment using approved secret storage.
  Never put keys in prompts or tracked configuration.
- For a local/git installation, set `DISPATCH_LINKUP_PACKAGE_DIR` to its trusted
  absolute package directory. This loads executable code, not a sandbox.

In-process workers load only the three Linkup entrypoints; extension discovery
stays off, with no balance command, unrelated extensions, or recursive dispatch.
Write-tier children receive the same tools and explicit entrypoints while keeping
their existing loader and spawning-tool exclusions. Missing keys/packages produce
a UI warning and leave local tools usable. Broken in-process tool registration
fails explicitly rather than pretending web access worked.

Calls consume Linkup credits and model tokens; simply exposing tools makes no
search request. Shared guidance recommends narrow fast/standard queries with
3–5 results, forbids sending secrets/private repository contents, and treats web
content as untrusted evidence. These are prompt guidelines, not enforced budgets
or data-loss prevention. Large results may create Linkup-managed temporary files;
roles with `read` can inspect them. Only final reports return to the parent.
The SDK forwards cancellation to the tools. Run `/reload` after updating.

## Write tier (worktrees)

**Before unattended use:** repository-wide merge locking and execution budgets
are still absent. Do not overlap write dispatches in the same repository.
Cancellation snapshots and signals the owned process tree on POSIX, including
detached tool groups, with a force-stop after a grace period. This is best-effort,
not containment: already reparented/daemonized processes can escape the snapshot.
The [historical audit](docs/audit-2026-09-06.md) describes earlier behavior; the
safety rules below and regression tests describe the current implementation.

Tasks marked `worktree: true` in parallel or chain mode run a child `pi` process
in a separate Git worktree. This mode commits worker changes and merges branches
back automatically; use it only with authorization for those effects. It also
updates and commits `.gitignore` bookkeeping when needed.

```
master agent
 └─ dispatch({ tasks: [{agent: "writer", task, worktree: true} × N] })
      ├─ git worktree add .dispatch/worktrees/t1 -b dispatch/<runId>/t1
      ├─ child pi #1 (cwd = worktree 1) ─ commits on its branch
      ├─ child pi #2 (cwd = worktree 2) ─ commits on its branch
      └─ after ALL finish: sequential `git merge --no-edit` per branch,
         conflict → merge agent (read/edit) resolves preserving BOTH
         sides, then worktrees removed (branches deleted after a clean merge)
```

- **Requires** a committed-clean git repo root (`git status --porcelain` empty) and the session cwd to be the repo root; per-task `cwd` is not allowed for worktree tasks.
- `.dispatch/` is added to `.gitignore` on first use; merge bookkeeping can commit
  that change automatically. Startup prunes only missing-worktree metadata;
  it never deletes existing directories by age. Dirty and locked worktrees remain
  under `.dispatch/worktrees/` for manual inspection/recovery.
- Child pi runs `pi -p --no-session --mode json` with the agent's system prompt (`--system-prompt`), tool allowlist (`--tools`, or `--no-tools` for `tools: none`), `--exclude-tools dispatch,pr_review,feature_plan` (recursion backstop) and `PI_DISPATCH_DEPTH=<parent+1>` (max depth 2).
- Workers' commit summaries (not diffs) return through the same context firewall and aggregator as the research tier.
- Successful write workers must leave a clean worktree before merge-back. Uncommitted
  edits change the result to an error with the retained worktree path.
- On abort, POSIX workers and known descendants get SIGTERM (SIGKILL after 5s).
  Clean, unlocked worktrees may be removed; dirty/locked worktrees and failed or
  aborted branches are **kept** for a human. Cleanup never bypasses Git's refusal
  with recursive deletion. Merge failures abort the merge and retain the branch;
  `details.merges` reports which branches failed and why.
- Fresh worktrees don't contain gitignored build deps (`node_modules/` etc.) — tasks that need builds should install or be scoped to source edits.
- Chain mode supports `worktree: true` per step; each step's branch merges before the next step runs.

## Agents

Frontmatter markdown, byte-compatible with the official example. Discovery: bundled (`agents/`) < user (`~/.pi/agent/agents/`) < project (`.pi/agents/`, trusted projects only).

Before each main-agent turn, dispatch adds the current names, descriptions, and
sources to its system context. This uses the same discovery and trust rules as
execution, so installed custom roles and overrides are visible before a call.
Generic role labels in skills are not agent names: use an exact roster name
(`scout` for research, `planner` for ideation, or an appropriate custom role).

Bundled: `scout` (read-only recon — tier `cheap`), `reviewer` (code review — `balanced`), `planner` (implementation plans — `long`), `aggregator` (fan-in specialist, no local tools — `balanced`), `security-reviewer` (application security — `precise`), `writer` (worktree write tier — implements, commits, and reports a summary — `precise`; dispatch with `model:'long'` for long-context writing tasks). Tier names in agent frontmatter `model:` expand via `src/profiles.ts`; see [Effort tiers](#effort-tiers).

## Install

Local development (dogfood inside this repo — `.pi/settings.json` is committed):

```bash
npm ci --ignore-scripts
npm run check
pi -p "dispatch two scouts …"
```

`npm run check` runs TypeScript and deterministic tests without calling models,
operating live Herdr, or committing in real project repositories. Git integration
tests create and remove disposable repositories. CI runs the same check on Linux
and macOS; live provider/Herdr checks remain separate.

Global: add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["~/path/to/pi-dispatch"] }
```

Or install the published Git repository: `pi install git:github.com/Pfgoriaux/pi-dispatch`.

Requires pi ≥ 0.84 (exported `createAgentSession`, `DefaultResourceLoader.noExtensions`, `parseFrontmatter`, `getAgentDir`).

## Status

- [x] Phase 0 — spikes (see `docs/spikes-phase0.md`): concurrent in-process workers, hermetic loaders, abort/partial results
- [x] Phase 1 — MVP: dispatch tool, modes, frontmatter agents, rendering, abort propagation
- [x] Phase 2 — aggregator double firewall + weighted model rosters with failover/cooldowns
- [x] Phase 3 — write tier (child `pi` processes in git worktrees + merge agent)
- [x] Phase 4 — Herdr observability (env-gated notifications), resumable worker sessions (opt-in), packaging

See also: "Model rosters", "Write tier (worktrees)", and "Resumable sessions & Herdr observability" below.

Historical design plan: [docs/plan.md](docs/plan.md). It records superseded
choices; use this README and the source for current behavior.

## Resumable sessions & Herdr observability

**Persist + resume (in-process tier, opt-in):** `dispatch({ ..., persist: true })`
stores SDK worker sessions under `~/.pi/agent/pi-dispatch/sessions` (indexed in
`index.json`). Write-tier child sessions are not persisted through this mechanism.
The tool result lists the persisted sessionIds; continue any of them with full
worker context via `dispatch({ resume: "<sessionId>", task: "continue..." })`.
Workers without `persist` stay in-memory exactly as before.

**Herdr:** when pi-dispatch runs inside a Herdr-managed pane (`HERDR_ENV=1`),
every completed dispatch fires a native notification (ok/failed counts,
duration, aggregation status). No-op everywhere else, and best-effort — never
blocks or fails a dispatch.

**Live identities:** tool output shows each planned worker's role immediately,
then its resolved provider/model, thinking level, attempt, and lifecycle state.
You do not need to expand the result to identify running workers. This applies
to `dispatch`, `pr_review`, and `feature_plan`.

**Herdr viewers:** inside Herdr, workers get viewer tabs in the **calling
workspace**, without moving focus. This works from non-Git directories such as
`eden/` and never creates Git branches just for display. Set `herdr: false` on
the tool call or a dispatch task to opt out. Tabs show bounded activity metadata,
not tool arguments/results or thinking transcripts. All owned tabs close when
the dispatch ends, including failed, cancelled, and unfinished viewers; their
temporary logs are removed. Failure summaries remain in the tool result.
If Herdr refuses cleanup, dispatch reports a warning and retains the affected logs.

**Spaces worker rows:** Herdr 0.8.2 also supports native metadata rows indented
beneath each workspace. Dispatch publishes worker role, selected model, retry
count and status through `src/spaces.ts`. Rows show `○` queued, `▶` running,
`✓` complete, `✗` failed, or `◍` aborted. They clear when dispatch ends, including
on failure/cancellation. A 20-second heartbeat renews their 60-second expiry so
crashed hosts do not leave stale rows. `herdr: false` disables rows and viewers.

Enable the layout once in `~/.config/herdr/config.toml` (merge these rows into an
existing Spaces section rather than duplicating the section):

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  ["$dispatch_1"], ["$dispatch_2"], ["$dispatch_3"], ["$dispatch_4"],
  ["$dispatch_5"], ["$dispatch_6"], ["$dispatch_7"], ["$dispatch_8"],
  ["$dispatch_9"], ["$dispatch_10"], ["$dispatch_11"], ["$dispatch_12"],
]
```

Run `herdr config check` then `herdr server reload-config`. Empty rows disappear.
The extension never edits this configuration automatically. Existing Pi sessions
need `/reload` after updating extension code.

Overlapping dispatch calls in the same Pi process share the rows without clearing
each other's workers. Up to 12 rows are shown; overflow uses the last row for a
count. Use a separate workspace for each master Pi process: Herdr metadata keys
are workspace-wide, not source-owned, so independent masters in the **same**
workspace can replace each other's rows. The `dispatch_1`–`dispatch_12` keys are
reserved for this integration.

Spaces rows are status labels, not individually clickable agent nodes. The viewer
tabs provide inspectable activity; execution still happens in isolated SDK
sessions or headless child processes. Neither surface creates Git worktrees.
Visibility failures appear in progress details and do not fail worker execution.

## Effort tiers

Agent frontmatter may name an effort tier instead of a concrete model
(`model: cheap | balanced | precise | long`). Tiers express *effort*, not
identity; anything needing model independence must use deliberately different
fixed models, because two workers on the same tier are correlated. Defaults
live in `src/profiles.ts` and are overridable with
`DISPATCH_PROFILE_<TIER>_MODEL`:

| Tier | Default model | Thinking | Notes |
|---|---|---|---|
| `cheap` | `neuralwatt/deepseek-v4.1-flash` | `off` | grep-and-report recon |
| `balanced` | `neuralwatt/glm-5.3` | `high` | general workhorse (provisional) |
| `precise` | `openai-codex/gpt-6-astra` | `high` | top tier — code writing, security review |
| `long` | `neuralwatt/kimi-k3` | `high` | dedicated long-effort/long-context model |

Tasks may also pick a model directly: `tasks: [{agent: "writer", model: "long", task}]`
accepts a tier name or an explicit `provider/id` and skips the agent's roster —
the standard way to run long-context writes on Kimi-3 while `writer` defaults
to `precise` (gpt-6-astra).

### Rosters as failover

`~/.pi/agent/settings/subagent-models.json` rosters win over frontmatter tiers,
so they are tuned tier-aligned: each agent's heaviest-weight entry is its tier
model, lowerweights are failover ladders. Keep it that way when editing — the
roster exists for cooldowns and failover, not for overriding effort intent.

## Acknowledgments

[aliou/pi-harness](https://github.com/aliou/pi-harness) informed the roster file
format and failure handling. This implementation sorts by descending weight,
fails over after a failed attempt, and keys cooldowns by provider/model. Sharing
a file format does not imply identical runtime semantics.


## The pi extension family

Three packages, one workflow: fan out, review, plan, protect, verify.

| Package | Job |
|---|---|
| [pi-dispatch](https://github.com/Pfgoriaux/pi-dispatch) | parallel sub-agent fan-out, merge-back, effort tiers, pr_review + feature_plan, Herdr worker viewers |
| [pi-repo-check](https://github.com/Pfgoriaux/pi-repo-check) | repository hygiene gate |
| [pi-worktree-guard](https://github.com/Pfgoriaux/pi-worktree-guard) | write-safety guard |

`pi-feature-swarm` and `pi-pr-swarm` were consolidated into pi-dispatch
(their tools live on as `feature_plan` and `pr_review`) and retired.
