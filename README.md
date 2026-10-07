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
and session-ID footers for `persist`/`resume`. Status, usage, and worker previews
live in `details` (UI-only). Raw worker transcripts are not returned to the parent.

**Modes:**
- `single` — `{ agent, task }`
- `parallel` — `{ tasks: [{agent, task, cwd?}] }`, max 8 tasks, concurrency 4; results distilled by `aggregator` unless `aggregate: false`
- `chain` — `{ chain: [{agent, task}] }`, sequential; `{previous}` = prior step's output

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

When `fix: true` is explicitly requested and verification succeeds, a `writer`
fixes the findings in a git worktree whose branch merges back automatically. The fix step requires a trusted, committed-clean repo root at the
session cwd and authorization for commits and automatic merge-back. `fix` defaults
to **false**. Invalid diffs fail before reviewers start; empty diffs skip model calls.
Fixes require the reviewed head to match the checkout; the checkout is rechecked
before writing and merging so findings cannot silently target another revision.
If any review material is truncated, the tool skips automatic fixes and asks for
a narrower review.

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
with `worktree: true` and the task's `Executor` as `model`. Read saved reports
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
database. Models resolve through
rosters, agent frontmatter, then the parent's active model as described below.
Single mode always runs in-process, even when the agent is named `writer`.

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
IDs the CLI cannot pin exactly fail before spawn. Merge children use the same registry checks.

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

**Before unattended use:** repository-wide merge locking and execution budgets
are still absent. Do not overlap write dispatches in the same repository.
Cancellation snapshots and signals the owned process tree on POSIX, including
detached tool groups, with a force-stop after a grace period. This is best-effort,
not containment: already reparented/daemonized processes can escape the snapshot.

Tasks marked `worktree: true` in parallel or chain mode run a child `pi` process
in a separate Git worktree. This mode commits worker changes and merges branches
back automatically; use it only with authorization for those effects.

```
master agent
 └─ dispatch({ tasks: [{agent: "writer", task, worktree: true} × N] })
      ├─ git worktree add <worktree root>/dispatch-<runId>-t1 -b dispatch/<runId>/t1
      ├─ child pi #1 (cwd = worktree 1) ─ commits on its branch
      ├─ child pi #2 (cwd = worktree 2) ─ commits on its branch
      └─ after ALL finish: sequential `git merge --no-edit` per branch,
         conflict → merge agent (read/edit) resolves preserving BOTH
         sides, then worktrees removed (branches deleted after a clean merge)
```

- **Requires** a committed-clean git repo root (`git status --porcelain` empty) and the session cwd to be the repo root; per-task `cwd` is not allowed for worktree tasks.
- Worktree root: repos inside the workspace (the parent of `PI_WORKTREE_ROOT`,
  default `~/eden/.worktrees`) mirror their main checkout's path under it, so
  `~/eden/products/app` uses `~/eden/.worktrees/products/app/`. Other repos use
  `<repo>/.dispatch/worktrees/`; for those, `.dispatch/` is added to `.gitignore`
  on first use and merge bookkeeping can commit that change automatically.
- Startup prunes only missing-worktree metadata; it never deletes existing
  directories by age. Dirty and locked worktrees remain under the worktree root
  for manual inspection/recovery.
- Child pi runs `pi -p --no-session --mode json` with the agent's system prompt (`--system-prompt`), tool allowlist (`--tools`, or `--no-tools` for `tools: none`), `--exclude-tools dispatch,pr_review,feature_plan,council,durable_batch` (recursion backstop) and `PI_DISPATCH_DEPTH=<parent+1>` (max depth 2).
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

## Durable pilot batches

A standalone CLI runs a fixed batch of writer tasks on a Durable store and
leaves draft pull requests for human review. It never merges branches and
never pushes to the base branch. It is separate from the `dispatch` tool.

```bash
node --import tsx src/durable/cli.ts run    batch.json   # create the batch and run it
node --import tsx src/durable/cli.ts resume batch.json   # continue after a stop or crash
node --import tsx src/durable/cli.ts status batch.json [--json]
node --import tsx src/durable/cli.ts stop   batch.json [--cancel]
# run/resume also take --expect-hash=<policy hash> and then start nothing if the file has another hash
```

Agents can prepare a batch with the `durable_batch` tool; the user approves the launch:

- `draft` validates a configuration with the same parser as the CLI and saves
  it as `~/.pi/agent/pi-dispatch/batches/<id>.json` (private directory and
  file). It refuses to change a batch that has a store.
- `launch` shows a Pi confirm dialog with the policy hash, repository,
  worker executable and model, allowance, deadline, publication target and
  `gh`, store and roots, and each task's owned paths, checks, and prompt (first
  200 characters). Only an approval starts one detached owner (`run`, or
  `resume` when the store exists), logging to `<id>.log` next to the draft;
  the tool returns its PID. The owner gets `--expect-hash=<policy hash>` and
  starts nothing if the file changed after approval. The tool runs alone in a
  turn. It refuses without a dialog-capable UI (print and JSON modes), inside
  dispatch workers, and while an owner is live.
- `status` and `stop` (`cancel: true` to cancel workers) use the owner socket.
- The pilot writer role lives in `agents/durable/`, outside the dispatch roster.

Every field is required, except `worker.piPrefixArgs`:

```json
{
  "batch": { "id": "night-1", "tasks": [
    { "id": "api", "dependencies": [], "ownedFiles": ["src/api/"],
      "checks": [["npm", "run", "check"]], "prompt": "..." },
    { "id": "docs", "dependencies": ["api"], "ownedFiles": ["README.md"],
      "checks": [["npm", "run", "check"]], "prompt": "..." }
  ] },
  "spend": { "allowanceUsd": 20, "reservations": { "api": 5, "docs": 3 } },
  "limits": { "maxWorkers": 3, "maxAttemptsPerTask": 2, "deadline": "2026-07-01T06:00:00+02:00" },
  "store": "/abs/path/night-1.sqlite",
  "repo": { "root": "/abs/repo", "baseBranch": "feat/x", "worktreesRoot": "/abs/.worktrees",
            "sessionsRoot": "/abs/sessions", "branchPrefix": "pilot/night-1" },
  "worker": { "piExecutable": "/abs/bin/pi", "model": "provider/id", "thinking": "high" },
  "publication": { "remote": "origin", "url": "git@github.com:owner/repo.git",
                   "repo": "owner/repo", "gh": "/abs/bin/gh" }
}
```

- Validation lists every missing or invalid field and starts nothing. `maxWorkers`
  is 1–3 and `maxAttemptsPerTask` is 1–2. Every task needs a positive
  reservation, and reservations must fit the allowance. The deadline needs a
  zone; `run` rejects one in the past or more than 24 days ahead.
- The store's policy hash covers every configuration field. `resume`, `status`,
  and `stop` need the same values; any change is refused.
- `ownedFiles` entries are repository-relative files or directories ending in
  `/`. Each task needs at least one check (argv, no shell). Checks run with the
  CLI's environment, so start it without production credentials.
- Checks run in the retained worker worktree. Ignored artifacts and dependencies
  are not independently reproduced in a fresh checkout. A worker must produce
  a commit with file changes; unchanged output is not verified.

```
cli.ts run
 ├─ validate config → open store (owner lock, recovery) → create root task → admit spend policy
 ├─ preflight: reconcile unresolved effects, read attempts, harness.inspect()
 │    └─ any blocker → print reasons and report, exit 2, scheduling never enabled
 └─ harness.resume() → root task
      ├─ spawn: one Durable task per batch task, in dependency order
      │    ├─ no dependencies → base = baseBranch commit recorded at `run`
      │    └─ dependencies → wait (allSettled) → base = verified parent head
      │         ├─ a parent not verified, its branch moved, or heads diverge → blocked
      │         └─ several parents: one head must contain the others (nothing is merged)
      ├─ each task: Supervisor attempt from ref <branchPrefix>/base/<task> at that base
      │    ├─ at most maxWorkers workers at once (attempts, reviews, adopted workers);
      │    │  a failed attempt retries until the cap
      │    ├─ running attempt left by a killed owner → adopt it (see Recovery)
      │    └─ succeeded attempt → review its head once (read-only, one slot, budgeted)
      │         ├─ validated blocker and attempts left → one fix attempt from that head → review again
      │         └─ otherwise → verified: head SHA, base SHA, checks passed, review recorded
      └─ after all tasks settle: publish in dependency order
           ├─ root task → draft PR against baseBranch
           ├─ dependent → draft PR stacked on the parent's branch, only if the parent is PR-ready
           └─ PR-ready only when the pushed SHA and the PR head equal the verified head
```

The report gives each task a state:

| State | Meaning |
|---|---|
| `pr-ready` | Verified, pushed, an open draft PR has the verified head, and its review found no validated blocker or was skipped |
| `verified` | Checks passed at the recorded head; not published, or published with unresolved blockers or a review without a usable answer (reason shown) |
| `failed` | Attempts ran and none succeeded |
| `blocked` | Not attempted or stopped by a dependency, the deadline, the budget, or a halted batch |
| `running` / `pending` | Not settled yet |

It also shows reported spend (attempts and reviews), halt reasons, review
counts, the recorded worker PID of running tasks, and short reasons. It never shows prompts, worker output, or reviewer
text. Reasons are cut to one line of 240 characters.

Review:

- After an attempt succeeds, one reviewer child runs with the bundled
  `reviewer` agent, restricted to `read`, `grep`, `find`, and `ls` (plus
  Linkup web tools when configured), on the configured worker model. It gets the `pr_review` correctness-and-security
  prompt and the saved diff from the task base to the head.
- The review is recorded on the attempt before it spawns, bound to the head
  SHA, and never repeated for that SHA. It takes a worker slot. A review
  that cannot start or ends without an answer is recorded as failed and does
  not halt the batch. It needs the
  task's reservation of headroom in the allowance; without it, or after the
  deadline, it is skipped. Unknown review spend halts the batch.
- A `[blocker]` finding counts as validated only when it cites a file the
  diff changes. A validated blocker starts one fix attempt from the reviewed
  head, inside `maxAttemptsPerTask`. A blocker that survives, or a failed fix,
  leaves the task verified at the reviewed head.
- The draft PR body gives the review counts and the reviewer's findings
  (up to 6000 characters).

Ownership and stopping:

- The `run`/`resume` process owns the store until it exits. It answers
  `status` and `stop` on a Unix socket in `$TMPDIR/pi-dispatch-<uid>/`; the
  directory must be private to the user.
- `stop` drains: no new attempts or publications start, running attempts
  finish, then the owner prints the report and exits. Unfinished tasks continue
  on `resume`. `stop --cancel` also stops running workers; their spend becomes
  unknown, which halts the batch. The first SIGINT/SIGTERM drains; a second
  cancels. SIGHUP cancels running workers.
- `status` without a live owner opens the store, which runs recovery, and
  prints the report without scheduling anything.
- `resume` refuses while any attempt or review is blocked, any spend is
  unknown, or an effect cannot be observed. A failed publication pauses at that
  step. Proven-absent pushes can retry on resume. Unconfirmed PR creation never
  retries automatically; closed, merged, retargeted or non-draft PRs block
  publication.

Recovery after a killed owner:

- The owner records each worker's PID and `ps` start time right after
  spawning it. A worker that exits before `ps` reads it is judged from its
  result without an identity; the owner saw it exit.
- Worker stdout goes to `events.log` in the run's session directory under
  `sessionsRoot`, not to a pipe, so a worker keeps running when its owner
  dies. Pi writes its own session file there through `--session-id` and
  `--session-dir`.
- On `resume`, an attempt or review still marked running is adopted; it is
  never respawned. Its slot is reserved when the store opens, so other tasks
  cannot take it first. The worker (recorded PID and start time) and its
  process group are awaited. At the deadline or on `stop --cancel`, the group
  gets SIGTERM, then SIGKILL after five seconds.
- Once it has exited, it is judged from its files. Completion needs
  `agent_settled` in `events.log`. Spend and the final answer come from the
  Pi session file, whose assistant messages must match the event log. A
  settled attempt then goes through the normal branch, ownership, and check
  verification.
- A worker that exited without settling fails with unknown spend. Missing or
  inconsistent files, a process group that survives SIGKILL, an identity that
  stays unreadable, a worker recorded on another host, or no recorded worker
  leave the attempt blocked with unknown spend.

Limits:

- Reservations and the allowance gate new attempts against spend that workers
  report. They are not a provider spending cap, and unpriced usage counts as
  unknown spend, which halts the batch.
- Workers and checks run as the user. Worktrees separate changes but do not
  contain processes; a worker's descendants can outlive cancellation.
- The review is one model's read-only pass, not the multi-model `pr_review`
  workflow.

## Agents

Frontmatter markdown, byte-compatible with the official example. Discovery: bundled (`agents/`) < user (`~/.pi/agent/agents/`) < project (`.pi/agents/`, trusted projects only).

Before each main-agent turn, dispatch adds the current names, descriptions,
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

Bundled: `scout` (read-only recon — tier `cheap`), `investigator` (code and runtime diagnostics — `precise`), `reviewer` (code review — `balanced`), `planner` (implementation plans — `long`), `aggregator` (fan-in specialist, no local tools — `balanced`), `security-reviewer` (application security — `precise`), `advisor` (read-only second opinion on decisions and risky or finished work — `precise`), `writer` (worktree write tier — implements, commits, and reports a summary — `precise`; dispatch with `model:'long'` for long-context writing tasks). Tier names in agent frontmatter `model:` expand via `src/profiles.ts`; see [Effort tiers](#effort-tiers).

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
| `balanced` | `anthropic/claude-sonnet-5-5` (Sol 6.1 peer) | `high` | Everyday coding, standard reviews, general work |
| `precise` | `anthropic/claude-opus-5-5` | `high` | Security, architecture, complex features, production-critical |
| `long` | `aperture/neuralwatt/kimi-k3` | `high` | Huge context (>100K tokens), multi-file refactors, research |

Tasks may also pick a model directly: `tasks: [{agent: "writer", model: "long", task}]`
accepts a tier name or an explicit `provider/id` and skips the agent's roster —
the standard way to run long-context writes on Kimi-3 while `writer` defaults
to `precise` (Opus 5.5).

### Rosters as failover

`~/.pi/agent/settings/subagent-models.json` rosters win over frontmatter tiers,
so they are tuned tier-aligned: each agent's heaviest-weight entry is its tier
model, lower weights are failover ladders. Keep it that way when editing — the
roster exists for cooldowns and failover, not for overriding effort intent.
