# Herdr review #1 — dispatch extension (commit 9f0fb2b)

Reviewed via `pr_review` fan-out (rev-range `e54c77d..HEAD`) on 2026-09-03:
- security (deepsec · GLM-5.3) — full structured findings
- code review (GLM-5.3) — transcript captured; findings extracted
- code review (Kimi-3) — transcript truncated by upstream 502/503s; first findings captured

Aggregation and fixes were applied by the master session after the swarm's
fix agent was aborted by transient gateway errors. All four substantive
findings were fixed in this repo; verification: chain-mode `$`-substitution
regression + parallel-mode E2E re-run (see commit).

## Fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **medium** | Aggregator output bypassed the 12KB truncation cap (violated the repo's own firewall rule). `details.truncated` hardcoded `false`; error strings uncapped; worker→aggregator inputs uncapped. (security + GLM + Kimi — all three converged) | `truncateText` applied to aggregated content, aggregator inputs, and error strings; `truncated` flag now propagates into `details` from every cap point |
| 2 | **major** | `replaceAll("{previous}", previous)` — `$&`, `$'`, `` $` `` substitution patterns in the replacement string silently corrupt chained worker output (code · GLM-5.3) | Replacer function: `replaceAll("{previous}", () => previous)` |
| 3 | low | Per-task `cwd` unvalidated — prompt-injected tasks could point workers anywhere on the filesystem | `validateTaskCwd`: realpath both sides, reject anything outside the session cwd subtree |
| 4 | low | Closure depth counter measured sibling tool-call concurrency, not nesting; a 3rd concurrent legitimate dispatch was falsely rejected | Removed; hermetic workers (`noExtensions`) documented as the sole, structural recursion guard |
| 5 | low | Chain mode had no length cap | `MAX_CHAIN_LENGTH = 8` with fail-fast validation alongside parallel's cap |
| 6 | minor | Dead code: `makeEmit`/`EmitFn`, unused `StringEnum` import, `boundaryDirty` variable; "N+1/N workers" progress glitch during aggregation | All removed; progress count capped at `items.length`; aggregator untracked in worker tally |
| 7 | minor | Dual typebox copies (own dep + pi-ai's) — schema-symbol compatibility risk | `Type` now imported from `@earendil-works/pi-ai` (official example convention); `typebox` dependency removed — the package now has zero deps |

## Not fixed (accepted / deferred)

- **cwd confinement is strict**: tasks cannot run outside the session cwd at
  all. Out-of-project dispatch may get an explicit opt-in setting later
  (security reviewer suggested confirm flow or allowlist).
- **Blank-response detection** (worker answers that are legit-empty vs
  provider-truncated) — planned Phase 2 roster work, unchanged.
- Reviewers noted resumable worker sessions and Herdr observability remain
  open Phase 4 items.

## Verdict

Firewall architecture survived review as the product's core; the fixes close
the one real hole in it (finding #1) plus a silent data-corruption bug in the
headline chain mode (finding #2). No disagreements between reviewers.
