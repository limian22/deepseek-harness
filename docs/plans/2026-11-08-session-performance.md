# Session Titles and Switching Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Restore titles for unopened historical sessions and avoid redundant history loading when navigating back to recent sessions.

**Architecture:** Keep synchronous cold listing cache-only. Add bounded asynchronous title recovery from durable session history with fail-soft persistence and list notifications. In the browser navigation owner, retain at most two recently viewed ordinary, nonblank sessions for a short TTL, preserving exact Session generations without changing the session service's reference-count contract. Do not speculate by activating sessions on hover.

**Tech Stack:** TypeScript, Cordis effect ownership, Vitest, existing session-query/persistence/projection APIs, existing Web build.

---

## Constraints and baseline

- Running checkout: `C:/Users/qq135/DSH/program/source/dsh`; never restart/stop/switch live services without explicit confirmation.
- Preserve unrelated dirty changes. Pre-existing tracked diff/status saved under `C:/Users/qq135/DSH/maintenance/session-performance-20261108`.
- Baseline: 168 passing manager, sessions-service and observation tests; three cold-list tests also pass, but accept missing titles on cache misses.
- Existing title cache is sparse relative to session directories. Cache misses currently never recover during listing.
- Scope references are intentionally destroyed at zero; optimization belongs in navigation as an explicit recent-session owner, not by weakening disposal.
- Do not persist recovered observation events that are not durable. Keep session logs untouched during title recovery, and never activate Agents merely to retrieve titles.

## Task 1: Recent-session navigation cache

**Files:**
- Modify: `packages/client/ui-workspace/src/client/navigation.ts`
- Optional helper: `packages/client/ui-workspace/src/client/recent-session-cache.ts`
- Tests: targeted navigation cases in `packages/client/ui-workspace/tests/`

1. Add a failing A→B→A regression asserting that the return reuses A's exact binding and does not reopen history.
2. Run the targeted test and record the expected failure.
3. Add an explicit recently-viewed reference owner: max two inactive eligible sessions, finite TTL, no speculative opens. Transfer ownership before releasing the main reference.
4. Cover capacity eviction, expiry, removal/archive/clear, disposal, rapid navigation and unsupported/blank/subagent exclusions.
5. Run `pnpm exec vitest run packages/client/ui-workspace/tests` and existing Session ownership tests. Do not alter zero-reference service disposal semantics.

## Task 2: Recover cold titles without opening conversations

**Files:**
- Primary owner: `packages/api/session-controller/src/list.ts`
- Lifecycle/notification integration: `packages/api/session-controller/src/index.ts`
- Durable checkpoint helper if needed: `packages/session/session-projection-cache/src/index.ts`
- Tests: `packages/api/session-controller/tests/session-cold.host.spec.ts` and targeted cache/query tests.

1. Establish exact durable-history input seam before choosing the write-back API.
2. Add failing test: listing an uncached stored titled session eventually publishes the title without creating an Agent or opening it in the browser.
3. Keep initial listing metadata-only. Recover titles through a deduplicated, bounded queue, yielding between sessions and supporting owner cancellation.
4. Persist only checkpoints derived from durable history with verified lifecycle identity; never write synthetic recovery events. Isolate corrupt/inaccessible histories and prevent infinite retry loops.
5. Verify a subsequent cold listing consumes the recovered title without reading history again. Validate removal, identity replacement, cancellation, partial cache rows and notifications.

## Task 3: Integration and evidence

1. Review the task-specific final diff and preserve unrelated changes.
2. Run related host/client regression suites and targeted lint/type checks.
3. Build affected client/Web artifacts using checkout scripts only after coordinated writes finish. No replacement server and no promise of live HMR (no development watcher was found).
4. Record structural performance evidence: repeated A→B→A follow/open counts before/after, bounded cached references and cleanup after expiry.
5. If browser scaffold timing is run, label it isolated synthetic evidence, not verification of the currently running public GUI. Public URL verification after refresh requires the approved deployment/restart boundary.
6. Report implemented/tested/built versus loaded/live separately; do not claim measured latency improvements from request-count tests alone.

## Verification record

- Navigation cache: two inactive ordinary sessions, two-minute TTL, explicit `recentlyViewed` ownership; clear/archive/remove/dispose release the retained references.
- Real `ClientSessions` + `SessionEventStream` with mocked transport: A opens one follow; B opens the second; returning to A keeps the total at two and preserves A's exact binding. Disposal closes both streams. This is structural evidence, not browser latency measurement.
- Integrator final client/fixture regression run: 21 files / 701 tests passed (ui-workspace, manager, sessions-service, SQLite query fixtures and subagent model-selection fixtures). Existing assembled-fixture tests print missing-create-stub diagnostics while passing; the run is not warning-free.
- Integrator final backend regression run: 18 files / 397 tests passed (query, projection registry/cache, cold list, scheduling, projection discovery and backfill). Together with the client/fixture run: 1,098 tests across 39 files passed.
- Independent navigation review closed its medium coverage finding and three low findings. Navigation/cache helper targeted coverage is 100% statements/branches/functions/lines; ui-workspace suite is 538 tests.
- Integrator lint on 16 source/test files: zero warnings/errors. `git diff --check`: passed.
- Initial complete build failed the host aggregate due to new fixture annotations, host/client test filename classification, and existing SQLite/subagent fixture types. Corrected fixtures without changing runtime semantics.
- Independent title review identified put/verify-time attach and lifecycle-replacement races, now covered by gated promise regressions; post-put persistence verification plus a final synchronous live guard prevent stale cold notifications. The finalizer also restarts a ready nonempty queue, with no spin on a missing title unit. Reviewer confirmed no remaining functional blocker.
- Optional-service startup integration replays the latest cold catalog when cache/persistence or the title service arrive late. Two first-list-before-mount scenarios pass without a second list pull. A failing history read is contained while other rows recover.
- Cold checkpointing now folds only `title` and `sessionListMetadata`, preserving other same-lifecycle rows. Registry `restore` accepts optional keys; omission preserves its full-fold contract. Projection/cache package suites: 146 passed; downstream consumer regression reported 952 passed / 10 skipped.
- Focused coverage: navigation/helper, title queue, projection registry/cache, and list owner each reach 100% statements/branches/functions/lines. The list owner uses the existing SessionCorpus convention to exclude only its stale optional-service disposer identity guard; no thresholds were lowered.
- Cordis API/catalog generation and freshness verification passed; generated output also synchronizes pre-existing subagent contract changes from the dirty checkout.
- Final complete build after all source changes with `NODE_OPTIONS=--max-old-space-size=8192`: 10 passed, 0 failed, 0 skipped; 83.15 seconds; recorded 367 client artifacts. No live restart or deployment has been performed.
- Remaining verification boundary: no public-browser latency or post-refresh live acceptance measured. Large logs still require reading/decoding, and React/Markdown remount cost remains; no percentage latency improvement is claimed.

## Deliberately deferred

Unbounded preloading, hover-triggered Agent activation, retaining all DOM trees, broad Markdown caches and chat virtualization are not part of the first fix. Measure remaining render cost before expanding scope. No automatic commits, profile mutations or service restarts.
