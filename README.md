# pi-dispatch

Pi extension that runs sub-agents in isolated sessions and returns only their final reports. It provides `dispatch`, `council`, `pr_review`, and `feature_plan`.

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
retained worktree/branch/commit references, and session-ID footers for `persist`/`resume`. Status, usage, and worker previews
live in `details` (UI-only). Raw worker transcripts are not returned to the parent.

**Modes:**
- `single` — `{ agent, task }`
- `parallel` — `{ tasks: [{agent, task, cwd?}] }`, max 8 tasks, concurrency 4; results distilled by `aggregator` unless `aggregate: false`
- `chain` — `{ chain: [{agent, task}] }`, sequential; `{previous}` = prior step's output

All four orchestration tools have `model-only` exposure: call them directly, not from codemode scripts.

## Advisor

`dispatch({ agent: "advisor", task: "..." })` gives a read-only second opinion.
Single consultations do not require parallel work or an explicit user request.

Include the outcome, decision, relevant paths, evidence, and constraints.
The advisor checks the evidence and returns a recommendation, reasons, risks,
and the smallest verification step. It cannot see the caller's conversation.

## Council

`council({ question, context?, third?, herdr? })` runs three independent advisors
in parallel, with high thinking:

| Seat | Model |
|---|---|
| Anthropic | `anthropic/claude-opus-5-5` |
| OpenAI | `openai-codex/gpt-6-astra` |
| Third | `aperture/neuralwatt/glm-5.3` by default; `third: "kimi-k3"` selects Kimi K3 |

Use it for consequential choices with competing options or an explicit request
for several opinions. One advisor handles focused second opinions;
`feature_plan` produces implementation plans and task contracts.

Every seat receives the same question and context, without the others' answers.
Supply evidence, paths, constraints, and applicable instructions. Workers use
the advisor role with local tools restricted to `read`, `grep`, `find`, and `ls`,
even if a custom advisor definition grants more tools. Shared Linkup tools
remain available. Workers do not inherit the caller's conversation.

Seats stay on their assigned model. GLM can retry through direct Synthetic;
Kimi can retry through Aperture Synthetic. Opus and Astra do not swap seats or
fall back to Sol. A resolved-model allowlist rejects other model identities.
Unavailable seats remain visible in the result, alongside actual model names,
failed attempts, and a count of successful opinions.

Only the three seats run; no aggregator model is called. The caller synthesizes
agreement, disagreement, its recommendation, and the smallest next check.
Each labeled report is capped at 12 KB. `herdr: false` disables viewers.
Zero successful opinions and cancellation are reported in the heading; like
the other workflows, these results resolve normally so reports and usage survive.

## pr_review

"Review a PR" without leaving dispatch. Resolves the diff (GitHub PR number
via `gh`, a git rev-range, a branch vs HEAD, or default `<origin/base>...HEAD`),
then runs five read-only steps:

```text
pr_review
├─ parallel
│  ├─ Opus 5.5 (`reviewer`): correctness + security
│  ├─ Codex Astra (`reviewer`): correctness
│  ├─ DeepSeek 4.1 Flash (`scout`, medium thinking): pre-mortem, "this merged; why did it break 3 months later?"
│  └─ `slop-reviewer` (balanced tier): checks added docs against its documentation rules and the code; flags unneeded tests and additions
└─ `reviewer` (balanced tier): check each finding against the code, merge duplicates, return one report and a verdict
```

Opus and Astra exclude each other on failover and share a model-identity guard,
so quota routing or fallback never gives both reviewers the same model. The
pre-mortem and slop steps stay outside the guard and cannot take a reviewer's
last fallback.
Both workflow pre-mortems are prompted to inspect the diff or draft, affected
files, direct callers and dependencies, and relevant tests. They expand only
for a concrete risk and return at most three evidenced failures with preventive
checks, or "None". These are prompt constraints, not enforced tool limits.
`pr_review` and `feature_plan` steps never use Sol 6.1. Every step ends its
chain with GLM 5.3 on Neuralwatt (`aperture/neuralwatt/glm-5.3`), then on
Synthetic (`synthetic/hf:zai-org/GLM-5.3`), so the workflows keep running when
Anthropic and OpenAI credits run out. Both routes count as one model in the
guard, so only one code reviewer can use GLM.
Each report is labeled with its actual model and failed attempts. If both code
reviewers fail, the tool stops. If verification fails, the unverified reports
are returned. Override models with `DISPATCH_REVIEW_OPUS_MODEL`,
`DISPATCH_REVIEW_ASTRA_MODEL`, and `DISPATCH_REVIEW_PREMORTEM_MODEL`.

When `fix: true` is explicitly requested and verification succeeds, a writer
commits fixes on a retained worktree branch. It does not merge. The fix step
requires a trusted, committed-clean feature repo root at the session cwd and
authorization to edit and commit. `fix` defaults to **false**.
The reviewed head must match the checkout before work starts; the fix branch
starts at that pinned commit. Invalid diffs fail before reviewers start; empty
diffs skip model calls. Truncated reviews skip fixes and request a narrower review.
The coordinator reviews the returned branch, integrates only with user authorization,
and tests the combined result. PR merges require user review and authorization.
For auth, migrations, concurrency, or shared-interface fixes, use review-only
mode, then dispatch the authorized fixes with `model: "precise"` and
`worktree: true`. The built-in `fix: true` path uses the default writer tier.

## feature_plan

"What would implementing X entail?" Four sequential read-only steps:

```text
feature_plan
├─ Architect (Astra): discover the code, draft the design
├─ Pre-mortem (DeepSeek 4.1 Flash): most likely failure in 3 months
├─ Challenger (Opus 5.5): review the draft, informed by the pre-mortem
└─ Architect (the draft's model): resolve the challenge, return the plan
```

Each successful step saves its complete report in a private Markdown file under
`<getAgentDir()>/pi-dispatch/plans/`, outside the repository. Reports are retained
until manually removed. Model-visible previews keep the 12 KB text cap and include
the saved path; later workers are instructed to read truncated reports in full.
If a truncated report cannot be saved, the workflow stops and returns its preview
with a warning. Full worker text remains in the tool result's `details.items`;
the warning includes the persisted session path when available.

With default models, architect and challenger use Astra or Opus 5.5, then GLM 5.3,
never the same model; the final step never uses the challenger's model. The
pre-mortem falls back to Synthetic DeepSeek, Sonnet 5.5, then GLM 5.3. GLM 5.3
runs on Neuralwatt, then Synthetic. No step uses Sol 6.1. A failed draft stops
the run. A failed pre-mortem or challenge is passed on as unavailable; a failed
final step returns the draft, pre-mortem, and challenge instead.
Override models with `DISPATCH_ARCHITECT_MODEL`, `DISPATCH_PREMORTEM_MODEL`, and
`DISPATCH_CHALLENGER_MODEL`.

The plan lists product decisions, then task contracts. Prompts scale detail to
scope: small features usually get one or two implementation contracts; larger
features can carry more coordination detail. Contracts specify ownership,
dependencies, interfaces, non-obvious decisions, and acceptance checks without
repeating the project context loaded by implementation sessions.

The tool does not execute contracts; after approval, dispatch each to `writer`
with `worktree: true` and the task's `Executor` as `model`, one call per repository.
Use `target` for a clean feature checkout inside the session directory. Review and
authorize integration before dispatching dependent work. Read saved reports
completely before using truncated contracts. Recover existing text instead of
restarting planning just because the preview was cut.

No repository edits, no Herdr needed.

**Isolation:** in-process workers disable extension discovery, skills, and context files.
Every worker also gets Linkup search/answer/fetch when configured; only those tool
entrypoints are added, not unrelated extensions (see below).
Write-tier child processes use different loading behavior and exclude `dispatch`.
Neither a cwd check nor a worktree is a filesystem sandbox; agents with `bash`
can access paths outside their starting directory. In-process tasks must include
applicable constraints or tell workers which instruction files to read.

The bundled scout, planner, and advisor have no write or shell tools. The
investigator and reviewer have `bash` and are read-only by instruction, not
enforcement. Shell access does not grant authorization to access a host or
database. In-process models resolve through
rosters, agent frontmatter, then the parent's active model as described below.
Single mode always runs in-process. The `writer` role requires `tasks` with
`worktree: true`; single, resume, and non-worktree writer requests are rejected.

## Model-specific guidance

Workers preserve their role and task while adding model-selected guidance from
`@pf/pi-model-prompts`. In-process workers select it after resolving each fallback;
child workers load its extension against the actual child model. Unknown models
are unchanged. The dependency is packed in `vendor/` so standalone installs work;
update the archive, dependency, and lockfile together after changing its source
in the sibling `pi-model-prompts` directory. No provider settings are changed.

## In-process model rosters

Configure ranked model rosters with automatic failover in
`~/.pi/agent/settings/subagent-models.json` (JSON, `<agentName> → array of candidates`).
Candidates are ranked by weight, not sampled:

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

Known Neuralwatt and Synthetic models retry **in either direction**. Both direct
and `aperture/` specs are recognized; tier defaults and inserted counterpart
routes use Aperture. The exact pairs are `kimi-k3` ↔
`synthetic/hf:moonshotai/Kimi-K3` and `deepseek-v4.1-flash` ↔
`synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash`. **GLM 5.3 stays on Neuralwatt; GLM Flash and
Kimi fast variants are not used.** Kimi and GLM 5.3 retain a final fallback to
**`openai-codex/gpt-6.1-sol`**, once, last, directly through Pi's Codex
subscription authentication (not Aperture or the billed OpenAI API).
DeepSeek 4.1 Flash (either provider) then falls back to
`anthropic/claude-sonnet-5-5`, then 6.1 Sol.
Unmapped IDs get no invented fallback routes.

`claude-opus-5-5` ↔ `gpt-6-astra` retry in either direction (top tier).
`claude-sonnet-5-5` retries `gpt-6.1-sol` next (balanced tier); Sol itself does
not expand to Sonnet because it is every chain's terminal fallback. Both pairs
are quota-routed and spend Codex first on a healthy tie.

**Quota routing:** rosters, frontmatter tiers, per-task tiers, and the default
workflow cross-check pair prefer the exact-model provider with the highest
bottleneck percentage across all reported quota windows. Synthetic's 5-hour
and weekly limits both count; a full 5-hour window cannot hide a depleted week.
A healthy tie (at least 50% remaining) prefers Synthetic. Different model
families keep their roster priority, and Codex stays the terminal fallback.
Concrete per-task/frontmatter model pins and `inherit` retain their provider
order and existing failure fallbacks.
Every model attempt in both worker tiers checks the latest cache and skips providers
with fresh, known zero headroom, including pinned, inherited, and fallback models.
Models blocked at selection do not consume an attempt or claim a parallel model identity.
SDK workers recheck quotas after async setup, before prompting. A setup-time
exhaustion skips the prompt without failed-attempt accounting or cooldown penalties;
the phase's early model reservation remains in place.
If every candidate is exhausted or already claimed, the worker returns an error
without calling a provider. A later positive reading makes the provider eligible again.
Child workers resolve bare IDs through the parent's registry, prefer the sole
authenticated match when several providers share an ID, and pass the canonical
provider and full model spec to Pi. Ambiguous IDs, unresolved defaults, and model
IDs the CLI cannot pin exactly fail before spawn.

Snapshots are read at spawn time from
`<getAgentDir()>/cache/usage-bar/<provider>-v3.json`, written by `pi-usage-bar`.
Aperture routes use their upstream provider's quota. Missing, invalid,
unquantifiable (physical balance without a total), or older-than-3-minute
readings leave that model's provider order unchanged;
expired reset windows also require a fresh reading. Upcoming/refill timestamps
do not promise restored capacity, so routing never spends a forecast refill.
Routing changes appear in UI-only progress warnings. No provider polling,
credential reads, or cache writes are added. Concurrent spawns may choose the
same provider; this is advisory routing, not a quota reservation system.

Failure fallback applies to in-process rosters, frontmatter, explicit overrides,
and inherited models. Write-tier children use the same fallback chain for startup
failures, but stop retrying once any tool has executed: replaying a fresh writer
could duplicate side effects. Thinking is preserved; target routes must be
registered/authenticated in Pi. Duplicate routes are tried once, cancellation
never triggers fallback, and exhaustion returns the last error. Unresolved
fallback entries do not hide the last provider error or mislabel its model.
The workflow tools prevent duplicate models within each parallel phase.
Ordinary `dispatch` tasks keep their existing routing and fallback behavior.

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

Write-tier children do not load the in-process roster or cooldown map. They
receive the task's model override or agent frontmatter model, falling back to
the parent for `inherit`, then apply the same exact-counterpart quota routing
and startup fallback rules. Thinking comes from the task's tier or agent
frontmatter and is forwarded through `--thinking`.

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

```text
coordinator → dispatch({ target?, tasks: [{agent: "writer", task, worktree: true}] })
  ├─ create isolated branches from one pinned feature commit
  ├─ writers edit, test, and commit their own files
  └─ return reports + branch, worktree, base/head commits, commit count
coordinator → review → authorized integration → combined tests → PR
user → review and authorize PR merge
```

- Requires authorization to edit and commit, and a clean feature checkout.
  `main`, `master`, `production` and detached HEAD are rejected.
- `target` defaults to the session cwd. An explicit target must resolve inside
  the session directory and be the repo root. Each call has one target.
  Per-task `cwd` is not allowed for worktree tasks.
- Only `tasks` supports worktrees. Chain worktrees are rejected; run dependent
  tasks after authorized integration, in a later call.
- Repos inside the workspace (the parent of `PI_WORKTREE_ROOT`, default
  `~/eden/.worktrees`) mirror their main checkout's path under it. Other repos
  use `<repo>/.dispatch/worktrees/`; `.dispatch/` is added to Git's local
  `info/exclude`, never to tracked `.gitignore`.
- Each successful writer must leave committed, clean edits. Uncommitted edits
  produce an error, with the worktree retained. A changed branch or base ancestry
  also produces a not-ready handoff naming the actual worktree HEAD for recovery.
  No empty commit is required.
- Once workers start, all their worktrees remain, including failed and aborted
  tasks. One task's exception becomes an error result; siblings finish normally.
  Branch references appear outside aggregator text and in `details.worktrees`.
- After verifying integration and a clean worktree, remove the returned path
  with `git worktree remove <path>`, then `git branch -d <branch>`.
  Stop if Git refuses. There is no age-based deletion or automatic merge.
- Children keep global extension discovery, but exclude the four orchestration
  tools and omit the Dispatch roster when `PI_DISPATCH_DEPTH > 0`.
  Depth above 2 is refused. They run `pi -p --no-session --mode json` with
  role tools, role prompt, and the assigned worktree.
- Workers are instructed not to launch nested agent CLIs through the shell.
  This is guidance, not a shell sandbox.
- Cancellation signals owned POSIX processes and known descendants, with a
  force-stop after a grace period. Already daemonized processes may escape.
- Fresh worktrees do not contain ignored dependencies such as `node_modules`.

### Startup failures

`PI_DISPATCH_STARTUP_TIMEOUT_MS` defaults to 120000 milliseconds. Invalid,
non-positive or out-of-range values use the default. Child startup must produce
an agent/message/tool-start event within this budget; a silent startup is stopped
without retrying other models. In-process prompts must produce model output
within this budget; timeout is an attempt failure and normal fallback applies.
The in-process timer begins after session setup. Neither timer limits healthy
workers' total runtime.

Spawn errors report an OS error code. Child stderr is never returned verbatim;
only recognized module/filesystem diagnostic codes can accompany an exit failure.

## Agents

Frontmatter markdown, byte-compatible with the official example. Discovery: bundled (`agents/`) < user (`~/.pi/agent/agents/`) < project (`.pi/agents/`, trusted projects only).

Before each main-agent turn (not inside a dispatch child), dispatch adds the current names, descriptions,
sources, role tool lists, and shell availability to its system context. This
uses the same discovery and trust rules as execution, including custom roles
and overrides. Workers do not inherit the parent's tools; configured Linkup
tools are added separately. Model tiers do not change tool access.
Generic role labels in skills are not agent names; use an exact roster name.

Select by capability: `scout` locates code, `investigator` checks code and runtime
causes, and `advisor` evaluates evidence and decisions. The investigator has
read/search tools and `bash`, without edit/write tools. Its prompt limits shell
use to authorized read-only diagnostics, including bounded SSH and database
checks; it forbids edits, installs, deployments, restarts, requeues, and production
writes. These limits are instructions, not a shell sandbox.

Dispatch's coordinator guidance requires checking returned commands against the
user's scope and safety rules, then completing authorized checks or delegating
them to a capable role. A blocked check needs a specific tool, access, or approval
blocker and a statement of what remains unverified. A worker's completed turn
does not establish that the investigation is complete.

Bundled: `scout` (read-only recon — tier `cheap`), `investigator` (code and runtime diagnostics — `precise`), `reviewer` (code review — `balanced`), `planner` (implementation plans — `precise`), `aggregator` (fan-in specialist, no local tools — `balanced`), `security-reviewer` (application security — `precise`), `slop-reviewer` (unnecessary code and docs — `balanced`), `advisor` (read-only second opinion on decisions and risky or finished work — `precise`), `writer` (worktree write tier — implements, commits, and reports a summary — `long`, Kimi K3). Tier names in agent frontmatter `model:` expand via `src/profiles.ts`; see [Effort tiers](#effort-tiers).

## Install

Development checks:

```bash
npm ci --ignore-scripts
npm run check
```

The repository does not auto-load its development extension into project sessions.
For an isolated extension load, use `pi -ne -e ./src/index.ts`.

`npm run check` runs TypeScript and deterministic tests without calling models,
operating live Herdr, or committing in real project repositories. Git integration
tests create and remove disposable repositories. CI runs the same check on Linux
and macOS; live provider/Herdr checks remain separate.

For a stable installation, pin a reviewed, pushed commit:

```bash
pi install git:github.com/Pfgoriaux/pi-dispatch@<commit>
```

Pi clones Git packages under its agent directory, separate from development
checkouts, and installs their runtime dependencies. A commit pin does not advance
when development branches move. Remove any local-path package entry for this
extension before enabling the Git entry: local paths and Git URLs have different
package identities. Replace the pin only during an intentional update.

Do not update the Pi binary underneath active sessions. Finish or stop workers,
then update and restart sessions. Change extension versions between tasks;
`/reload` changes the code used by that session.

Requires Pi 1.0.4 or newer. Deterministic checks use the pinned 1.0.4 SDK.

## Resumable sessions & Herdr observability

**Persist + resume (in-process tier, opt-in):** `dispatch({ ..., persist: true })`
stores SDK worker sessions under `~/.pi/agent/pi-dispatch/sessions` (indexed in
`index.json`). Write-tier child sessions are not persisted through this mechanism.
The tool result lists the persisted sessionIds; continue any of them with full
worker context via `dispatch({ resume: "<sessionId>", task: "continue..." })`.
Workers without `persist` stay in memory.

**Herdr:** when pi-dispatch runs inside a Herdr-managed pane (`HERDR_ENV=1`),
every completed dispatch fires a native notification (ok/failed counts,
duration, aggregation status). No-op everywhere else, and best-effort — never
blocks or fails a dispatch.

**Live identities:** tool output shows each planned worker's role immediately,
then its resolved provider/model, thinking level, attempt, and lifecycle state.
You do not need to expand the result to identify running workers. This applies
to `dispatch`, `council`, `pr_review`, and `feature_plan`.

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

## Standalone Herdr workers

`herdr_watch` watches agents prompted directly through Herdr, outside `dispatch`.
After a successful `herdr agent prompt`, register the worker's name or pane ID:

```json
{ "action": "watch", "targets": ["worker-a", "worker-b"] }
```

The tool resolves each name to a pane and session identity in the caller's
workspace. Every three seconds, a bounded Herdr CLI check reads their states.
When a worker settles or blocks, Pi receives a follow-up that wakes an idle
coordinator or queues behind its current run. The coordinator reads the
worker's response; terminal `idle`/`done` is not task success.

Watches are one-shot. After sending a continuation, register that worker again.
Use `action: "list"` to inspect watches or `action: "clear"` to stop all watches
without stopping workers. A watch ends only when Pi confirms its notice entered
the conversation; a queued notice cleared by Esc is retried when the coordinator
goes idle. Missing or unknown agents produce an alert after three checks;
a replaced session produces an alert instead of following its replacement.
The watcher never sends worker prompts, grants approvals, or reads transcripts.

Watches require a persistent TUI or RPC coordinator; print mode is rejected.
Pending watches are stored in the coordinator's session and restored on reload
in the same Herdr server and workspace. Forked sessions do not inherit them; tree navigation
clears them. No monitoring runs while Pi is closed. This is not a durable
message queue and does not guarantee exactly-once delivery across crashes.
Inside Herdr the tool loads with Dispatch; existing sessions need `/reload`.

## Effort tiers

Agent frontmatter may name an effort tier instead of a concrete model
(`model: cheap | balanced | precise | long`). Tiers express *effort*, not
identity; anything needing model independence must use deliberately different
fixed models, because two workers on the same tier are correlated. Defaults
live in `src/profiles.ts` and are overridable with
`DISPATCH_PROFILE_<TIER>_MODEL`:

| Tier | Default model | Thinking | When to use |
|---|---|---|---|
| `cheap` | `aperture/neuralwatt/deepseek-v4.1-flash` | `off` | Simple lookups, grep-and-report, boilerplate |
| `balanced` | `anthropic/claude-sonnet-5-5` (Sol 6.1 peer) | `high` | Standard reviews, synthesis, general work |
| `precise` | `anthropic/claude-opus-5-5` | `high` | Security, architecture, complex features, production-critical |
| `long` | `aperture/neuralwatt/kimi-k3` | `high` | Default coding, multi-file refactors, research |

Tasks may also pick a model directly: `tasks: [{agent: "writer", worktree: true, model: "aperture/neuralwatt/glm-5.3", task}]`
accepts a tier name or an explicit `provider/id` and overrides agent frontmatter.
Select GLM 5.3 for small, well-bounded tasks or `precise` for auth,
migrations, concurrency, and shared-interface work. Without an override, the
bundled writer uses `long` (Kimi K3), including `pr_review` fixes. The bundled
standalone planner uses `precise`; `feature_plan` explicitly assigns Astra and
Opus to its architect and challenger. User/project agent definitions, tier
environment overrides, quota steering, and existing failure fallbacks still apply.

### Rosters as failover

In-process workers use `~/.pi/agent/settings/subagent-models.json` rosters before
frontmatter tiers; a per-task model override bypasses the roster. Worktree writers
and review-fix children do not read those rosters. They use the task override or
agent frontmatter, followed by their provider fallback chain.
