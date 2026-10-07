# pi-dispatch

Delegation tools for Pi. Workers return reports; writers also return retained
branches. Dispatch never integrates code or merges PRs.

```text
coordinator
├─ research/review workers → findings
└─ writers → isolated worktrees → tests + commits → branch handoffs
coordinator → review → authorized integration → combined checks → PR
user → review and authorize PR merge
```

## Tools

All four tools are `model-only`: call them directly, not through codemode.

| Tool | Use |
|---|---|
| `dispatch` | One helper, parallel tasks, or sequential research |
| `feature_plan` | Read-only design and implementation contracts |
| `pr_review` | Read-only review; optional fixes on a retained branch |
| `council` | Three independent opinions on a consequential decision |

Do routine work directly. Use one advisor for focused judgment; multiple workers
for independent or context-heavy tasks. Each task needs its goal, paths, constraints
and deliverable because workers do not see the coordinator's conversation.

### Dispatch modes

- `{ agent, task }`: one in-process worker.
- `{ tasks: [{ agent, task, cwd?, model?, worktree? }] }`: up to 8 tasks,
  concurrency 4. An aggregator normally combines reports; `aggregate:false`
  returns them separately.
- `{ chain: [{ agent, task, cwd?, model? }] }`: up to 8 sequential steps;
  `{previous}` inserts the preceding report. Chain worktrees are rejected.
- `persist:true` retains in-process sessions under
  `<agentDir>/pi-dispatch/sessions`, with lookup records in `pi-dispatch/index.json`.
  Continue with `{ resume: "<sessionId>", task: "..." }`.
  Write children do not use this persistence path.
- `herdr:false` disables viewers/metadata; a task-level value overrides it.

Per-task `cwd` must resolve inside the session directory. A `writer` requires
`tasks` with `worktree:true`; single/resume and non-worktree writer calls fail.
Other roles' shell permissions remain instructions, not a filesystem sandbox.

### Writer handoffs

```js
dispatch({
  target: "/path/inside/session/feature-checkout",
  tasks: [{ agent: "writer", task: "...", worktree: true }]
})
```

- `target` defaults to the session cwd. It must be a clean repo root on a named
  feature branch; `main`, `master`, `production` and detached HEAD are rejected.
  A call has one target. Worktree tasks cannot set per-task `cwd`.
- Worktrees branch from one pinned commit. Writers need authorization to edit
  and commit, stage only task files, and do not push or merge.
- A successful writer must leave clean edits, the assigned branch and a HEAD
  descending from its base. Changed/detached branches return an error with the
  actual HEAD for recovery. No-op tasks do not create empty commits.
- Every started worktree stays, including failed/aborted tasks. One worker's
  exception becomes its error result while siblings finish.
- The handoff includes path, branch, base/head commits, count and readiness.
  It appears outside aggregator text and in `details.worktrees`.
- The coordinator reviews selected branches and integrates only with user
  authorization. Test the combined code before dispatching dependent work.
  PR merges remain a separate, user-reviewed action.
- Keep not-ready worktrees for recovery. After verified integration and a clean
  tree, use `git worktree remove <path>`, then `git branch -d <branch>`.
  Stop if Git refuses; there is no forced or age-based deletion.

Repos inside the workspace (parent of `PI_WORKTREE_ROOT`, default
`~/eden/.worktrees`) mirror their main checkout path under that directory.
Other repos use `<repo>/.dispatch/worktrees`, excluded through Git's local
`info/exclude`, not tracked `.gitignore`. New worktrees lack ignored dependencies
such as `node_modules`; install them only when authorized.

### Feature planning

```text
feature_plan({ idea, focus? })
└─ Architect (Astra): discover and draft
   └─ Pre-mortem (DeepSeek): inspect likely failure
      └─ Challenger (Opus): independently check the design
         └─ Architect: resolve issues and return task contracts
```

The draft and final architect use the same model; the challenger cannot use it.
Prompts scale detail to scope and put unresolved product decisions before tasks.
The tool does not implement its plan. After approval, execute contracts verbatim
with the named Executor, one repository per dispatch call.

Full successful reports are saved privately under `<agentDir>/pi-dispatch/plans`.
Previews are capped at 12 KB and include paths; later steps read full reports
when previews are truncated. If a truncated report cannot be saved, planning
stops and returns its preview plus a session recovery path when available.
Recover existing reports rather than replanning because a preview was cut.
Reports remain until manually removed.

A failed draft stops the run. Missing pre-mortem/challenge results remain visible;
a failed final step returns earlier reports. Configure defaults with
`DISPATCH_ARCHITECT_MODEL`, `DISPATCH_PREMORTEM_MODEL` and
`DISPATCH_CHALLENGER_MODEL`.

### PR review

`pr_review({ pr?, intent, fix?, herdr? })` accepts a GitHub PR number (via `gh`),
revision range, branch compared with HEAD, or the default origin-base comparison.
Invalid diffs fail before models start; empty diffs skip model calls.

```text
parallel
├─ Opus reviewer: correctness/security
├─ Astra reviewer: correctness
├─ DeepSeek scout (medium thinking): pre-mortem
└─ slop-reviewer: unnecessary code/docs
reviewer → verify findings against diff and code → report
```

The two code reviewers cannot share a model after fallback. If both fail, review
stops; failed verification returns unverified reports. Configure the first three
steps with `DISPATCH_REVIEW_OPUS_MODEL`, `DISPATCH_REVIEW_ASTRA_MODEL` and
`DISPATCH_REVIEW_PREMORTEM_MODEL`.

`fix` defaults to false. Authorized fixes require a trusted, clean feature repo
root matching the reviewed head. After successful, untruncated verification, a
writer starts from that pinned head and returns a retained branch, never a merge.
It uses the default writer tier. For auth, migrations, concurrency or shared
interfaces, review only, then dispatch an authorized `precise` writer.

### Council

`council({ question, context?, third?, herdr? })` runs Opus, Astra and GLM 5.3
by default; `third:"kimi-k3"` replaces GLM. All use high thinking and the advisor
role, restricted to local read/search tools even when custom roles grant more.
Configured Linkup tools remain available.

Seats stay on their assigned model. GLM/Kimi can retry an equivalent provider
route; unavailable seats are reported, not replaced by another model. No aggregator
runs. The coordinator summarizes agreement, dissent, its recommendation and the
smallest next check. Fewer than three successful opinions is not a full council.

## Agents and models

Discovery order: bundled `agents/`, user `<agentDir>/agents/`, then trusted
project `.pi/agents/`; later definitions override earlier ones. The coordinator
receives current role names and tools before each turn, not all role prompts.

| Role | Local tools | Default tier |
|---|---|---|
| scout | read/search | cheap |
| investigator | read/search, bash (read-only diagnostics) | precise |
| advisor | read/search | precise |
| planner | read/search | precise |
| reviewer | read/search, bash (read-only inspection) | balanced |
| security-reviewer | read/search, bash (read-only inspection) | precise |
| slop-reviewer | read/search, bash (read-only inspection) | balanced |
| aggregator | none | balanced |
| writer | read, edit, write, bash | long |

| Tier | Default model | Thinking |
|---|---|---|
| cheap | Aperture Neuralwatt DeepSeek V4.1 Flash | off |
| balanced | Anthropic Sonnet 5.5 | high |
| precise | Anthropic Opus 5.5 | high |
| long | Aperture Neuralwatt Kimi K3 | high |

Use Kimi for default coding, explicit `aperture/neuralwatt/glm-5.3` for small,
well-bounded tasks, and `precise` for high-risk coding. Override a tier with
`DISPATCH_PROFILE_<TIER>_MODEL` or a task's `model` with a tier or `provider/id`.
Model choice never grants additional tools or authorization.

In-process selection uses a task override, otherwise an agent roster, then
frontmatter, then the parent model. Rosters live in
`<agentDir>/settings/subagent-models.json`:

```json
{
  "planner": [
    { "provider": "anthropic", "model": "claude-opus-5-5", "thinking": "high", "weight": 2 },
    { "provider": "openai-codex", "model": "gpt-6-astra", "thinking": "high", "weight": 1 }
  ]
}
```

Weights are positive and ordered descending, not sampled. A task model override
bypasses the roster. Worktree/review-fix children do not read in-process rosters
or cooldowns: they use the task override or frontmatter, then parent for `inherit`.
Child IDs resolve through the parent registry; ambiguous or unpinnable IDs fail
before spawn.

### Routing and failure

- Kimi and DeepSeek retry their Neuralwatt/Synthetic counterparts (direct and
  Aperture routes supported). Kimi and GLM 5.3 retain a terminal Codex Sol 6.1
  fallback; DeepSeek falls back through Sonnet then Sol.
- Opus and Astra retry each other and end with Sol; Sonnet also falls back to Sol.
  Ordinary GLM routing stays on Neuralwatt before Sol; workflow last resorts
  additionally include GLM on Neuralwatt and direct Synthetic.
- `feature_plan` and `pr_review` exclude Sol and end their chains with GLM 5.3
  on Neuralwatt, then direct Synthetic. Model-identity guards prevent duplicates.
  Council instead restricts each seat to its assigned model.
- Quota steering ranks existing peer candidates without inserting a top model.
  Tiers/rosters opt in; concrete pins and `inherit` keep provider order.
  Every attempt still skips fresh, known exhausted providers.
- Snapshots come from `<agentDir>/cache/usage-bar/<provider>-v3.json` written by
  pi-usage-bar. Use the lowest remaining percentage across reported windows.
  Missing, invalid, older-than-three-minute or expired-reset readings do not
  predict capacity. Dispatch neither polls providers nor reserves quota.
- In-process failures, blank final responses and internal cutoffs can try the
  next candidate. Usage includes all attempts. Cooldowns last 60 seconds per
  provider/model. Cutoffs occur after 3 unavailable-tool calls or 5 consecutive
  tool errors; success resets them.
- A write child is never replayed after a tool starts. Parent cancellation wins
  over failures and never triggers retry.
- `PI_DISPATCH_STARTUP_TIMEOUT_MS` defaults to 120000. Child startup waits for
  an agent/message/tool-start event; silent startup is stopped without retry.
  In-process prompts wait for model output after session setup; timeout follows
  normal fallback. Healthy workers have no total-runtime deadline.
- Child startup failures expose OS/module diagnostic codes, never raw stderr.
  Malformed tool names are redacted, not repaired. POSIX cancellation signals
  owned processes and known descendants, escalating after a grace period;
  already daemonized processes may escape.

## Context and tools

Only the selected role prompt loads into a worker, plus shared worker rules and
model-family guidance from the packaged `@pf/pi-model-prompts` dependency.
Keep its vendor archive, dependency and lockfile together when updating it.

In-process workers disable general extension, skill and context-file discovery.
Their tasks must provide constraints or name applicable instruction files.
Write children use normal project/global loading, exclude the orchestration
tools, and omit the Dispatch roster when `PI_DISPATCH_DEPTH > 0`. Depth above 2
is refused. Roles, worktrees and cwd checks are not sandboxes; shell access reaches
outside the assigned directory. Workers are instructed not to launch agent CLIs
to bypass tool or delegation restrictions.

Configured Linkup search/answer/fetch tools are added to all workers, even roles
without local tools. In-process workers load only those entrypoints. Install
`npm:@aliou/pi-linkup` and supply `LINKUP_API_KEY` through approved secret storage.
For a trusted local/Git package, set `DISPATCH_LINKUP_PACKAGE_DIR` to its absolute
path. Missing setup warns and leaves local tools usable; broken registration
fails explicitly. Never send secrets/private code in queries.

Final reports and recovery references enter model-visible `content`.
Status, usage and previews are in UI-only `details`. Worker/error texts have
a 12 KB UTF-8 cap per text plus a truncation marker, not per combined result. Raw transcripts stay inside
workers; saved reports/session references allow recovery without repeating work.

## Herdr

Herdr is optional. Inside Herdr, viewers and Spaces metadata show role, model,
attempt and state; `herdr:false` opts out. Neither surface executes extra agents.
Notifications and visibility failures are non-fatal. Owned tabs/rows are cleaned
up at the end; failed cleanup reports a warning and retains affected logs.

Use one coordinator per Herdr workspace. Calls in the same Pi process share rows,
but independent processes can overwrite workspace-wide keys. The extension reserves
`dispatch_1`–`dispatch_12`; overflow is counted in the final row. Heartbeats renew
60-second metadata expiry every 20 seconds.

Spaces configuration (Herdr 0.8.2+), merged into `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"], ["branch", "git_status"],
  ["$dispatch_1"], ["$dispatch_2"], ["$dispatch_3"], ["$dispatch_4"],
  ["$dispatch_5"], ["$dispatch_6"], ["$dispatch_7"], ["$dispatch_8"],
  ["$dispatch_9"], ["$dispatch_10"], ["$dispatch_11"], ["$dispatch_12"],
]
```

Check with `herdr config check`, then `herdr server reload-config`.
Metadata rows are labels, not clickable agents; viewer tabs show activity.
The extension does not edit Herdr configuration.

### Standalone workers

For workers prompted through Herdr directly, call
`herdr_watch({ action:"watch", targets:["worker-name-or-pane-id"] })` afterwards.
The watcher polls every three seconds, following pane/session identity.
A settled or blocked worker sends a coordinator follow-up; idle/done is not proof
of task success. Read the response, resolve authorized blockers, and re-register
after each continuation. `list` shows watches; `clear` stops watches, not workers.

Watches require TUI/RPC, not print mode. Notices remain pending until delivered,
survive reload in the same workspace/session, and do not follow forks or tree
navigation. Missing workers alert after three checks; replaced sessions alert
rather than being followed. No monitoring runs while Pi is closed, and delivery
is not exactly-once across crashes. The watcher never prompts workers or grants
permission.

## Install and checks

Requires Pi 1.0.4+. Pin a reviewed, pushed commit:

```bash
pi install git:github.com/Pfgoriaux/pi-dispatch@<commit>
```

Pi installs Git packages under its agent directory, separately from development
checkouts. Remove this extension's local-path settings entry before enabling the
Git entry; those sources have different package identities. Replace pins
intentionally between tasks. Stop workers before updating the Pi binary, then
restart sessions.

Development:

```bash
npm ci --ignore-scripts
npm run check
```

Checks cover TypeScript and deterministic tests on Linux/macOS, using disposable
Git repos and mocked models/commands. They do not verify live providers or Herdr.
The repository does not auto-load its extension into development sessions;
use `pi -ne -e ./src/index.ts` for an explicit isolated load.

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
  worker executable and model, reviewer models, allowance, deadline, publication target and
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
  "worker": { "piExecutable": "/abs/bin/pi", "model": "aperture/neuralwatt/kimi-k3", "thinking": "high" },
  "reviewer": { "model": "openai-codex/gpt-6-astra",
                "fallbacks": ["aperture/neuralwatt/glm-5.3"] },
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
- `reviewer.model` and its non-empty `fallbacks` list require exact `provider/id`
  values. They must be distinct from each other and from `worker.model`.
  Retries use the next reviewer model; skipped budget/deadline claims do not
  advance it. Two failed tries exhaust the review, so only the first fallback
  can run for a head.
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
      │    └─ succeeded attempt → review its head (read-only, one slot, budgeted)
      │         ├─ review cannot finish (budget, deadline, reviewer error) → pause the batch;
      │         │  resume reviews the same head again
      │         ├─ two failed review tries for that head → task blocked; other tasks continue
      │         ├─ validated blocker and attempts left → one fix attempt from that head → review again
      │         └─ otherwise → verified: head SHA, base SHA, checks passed, review completed
      └─ after all tasks settle: publish in dependency order
           ├─ root task → draft PR against baseBranch
           ├─ dependent → draft PR stacked on the parent's branch, only if the parent is PR-ready
           └─ PR-ready only when the pushed SHA and the PR head equal the verified head
```

The report gives each task a state:

| State | Meaning |
|---|---|
| `pr-ready` | Verified, reviewed, pushed, an open draft PR has the verified head, and its review found no validated blocker |
| `verified` | Checks passed at the recorded head; review pending (`review pending: <why>`), not published, or published with unresolved blockers (reason shown) |
| `failed` | Attempts ran and none succeeded |
| `blocked` | Not attempted or stopped by a dependency, the deadline, the budget, or a halted batch |
| `running` / `pending` | Not settled yet |

It also shows accounted spend (reported usage plus stopped-review charges), halt reasons, review
counts, the recorded worker PID of running tasks, and short reasons. It never shows prompts, worker output, or reviewer
text. Reasons are cut to one line of 240 characters.

Review:

- After an attempt succeeds, one reviewer child runs with the bundled
  `reviewer` agent, restricted to `read`, `grep`, `find`, and `ls` (plus
  Linkup web tools when configured), on `reviewer.model`. It gets the `pr_review` correctness-and-security
  prompt and the saved diff from the task base to the head.
- Every task needs a completed review of its head before it settles, before
  dependents start from it, and before publication. The review is recorded on
  the attempt before it spawns and bound to the head SHA; a completed review
  is never repeated. It takes a worker slot and needs the task's reservation
  of headroom in the allowance (reservations of running work count).
- A review that does not fit the allowance, comes after the deadline, cannot
  start, or ends without an answer is recorded as skipped or failed. The task
  stays `verified` with `review pending: <why>`, nothing is published, and the
  batch pauses like `stop`. `resume` reviews the same head with the next model
  after a failure; a failed try's spend stays counted. Budget/deadline skips
  do not count as failures. After two failures, the task is blocked with
  `review failed twice`, never published, and other tasks continue.
  Unknown spend and ambiguous worker outcomes still halt the batch.
- One review try may run for 20 minutes, counted from its start (also after a
  resume adopts it); `PI_DISPATCH_DURABLE_REVIEW_LIMIT_MS` changes this for an
  owner. A review stopped by the owner or time limit charges its full reservation
  (or reported spend if higher), pauses with `review pending: reviewer timed out`
  or `review pending: reviewer cancelled by owner`, and can retry on resume.
  This is conservative bookkeeping, not a measured provider bill or a spending
  cap. The stop intent is recorded before signalling the child; recovery
  confirms its process group exited before charging it once.
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
  on `resume`. `stop --cancel` also stops running workers. Stopped writers
  with unknown spend halt the batch; stopped reviews use the charge above.
  The first SIGINT/SIGTERM drains; a second
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
- A worker that exited without settling fails with unknown spend unless it
  is a review with a recorded owner stop. Missing or
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
