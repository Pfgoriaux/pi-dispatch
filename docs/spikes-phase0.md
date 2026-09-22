# Phase 0 spike results

> Historical measurements against the version named below. Treat API quirks and
> timings as observations from that run, not requirements for all pi versions.
> The deferred list is not a current work queue; see [README](../README.md).

Run 2026-09-03 against the installed pi 0.84.4, provider aperture/neuralwatt (GLM-5.3).
Spike scripts were throwaway (`/tmp/spikes/`); conclusions below are the durable output.

## Spike 1 — concurrent in-process workers ✅

3 `createAgentSession()` workers in one Node process, shared `ModelRuntime`:

- Setup 345–408 ms per worker (with the global 21 extensions loaded).
- Correct isolated answers, no cross-session bleed; RSS 176 MB.
- Standalone `ModelRuntime.getAvailable()` does **not** include extension-registered
  providers (e.g. aperture) — see model-sharing finding below.

## Spike 2 — hermetic workers ✅

`DefaultResourceLoader` with `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`
and custom `systemPrompt`:

- Loader setup **3–45 ms** (≈10× faster than full extension load), `exts=0`.
- Two concurrent hermetic workers work fine.

Findings:
1. `DefaultResourceLoaderOptions.agentDir` is a **required string**; passing `undefined`
   throws deep inside `resolvePath → normalizePath` (`...startsWith`). Use `getAgentDir()`.
   (This bit the first E2E run; fixed in `src/worker.ts`.)
2. With a custom system prompt, pi sends it with the `developer` role. The neuralwatt
   endpoint rejects that; models.json `compat.supportsDeveloperRole: false` fixes it.
   Not needed for the parent's default prompt.

## Spike 3 — abort → partial results ✅

`session.abort()` mid-stream:

- `prompt()` resolves (does not throw); `stopReason: "aborted"`.
- `getLastAssistantText()` returns the partial text streamed so far.
- `dispose()` during/after abort is clean.
- Worker result on abort: status `aborted` + partial text (kept, marked).

## Model sharing (from aliou/pi-harness agent-kit, reimplemented) ✅

A fresh `ModelRuntime` doesn't know providers registered by extensions in the parent
process. `src/model.ts` copies `registry.getRegisteredNativeProvider(model.provider)`
into the worker runtime (`registerNativeProvider`) and mirrors the resolved API key via
`setRuntimeApiKey` (tolerating `CredentialSynchronizationError` from opportunistic
refreshes). Verified end-to-end through the aperture proxy.

## E2E verification ✅

`pi -e ./src/index.ts -p` on this repo:
- parallel: 2 scouts (5.5 s / 3.0 s) + aggregator (3.1 s), `aggregated: true`,
  master-visible content = consolidated report only.
- chain: scout → `{previous}` → planner output verified.

## Deferred

- Worktree cwd binding + session-file collision check (gates Phase 3, not Phase 1).
- In-process session-file naming for parallel persisted workers (workers currently use
  `SessionManager.inMemory`, so N/A).
