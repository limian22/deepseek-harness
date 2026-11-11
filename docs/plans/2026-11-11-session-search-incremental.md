# Incremental session search implementation plan

English | [中文](2026-11-11-session-search-incremental.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: 本次会话内直接执行（TDD）— same-session execution with delegated implementers and read-only automated review checkpoints; no additional per-batch human approval. Deployment remains separately authorized.

**Goal:** Return authorized indexed history without awaiting full-corpus reads, while background synchronization persists resumable progress and reports incomplete coverage.

**Architecture:** Preserve the existing synchronous provider mode for callers that require exact search-time reconciliation. Add a background mode to the SQLite provider, persist only validated per-session generations, and keep live data preferred. Offload CPU-heavy preparation/index publication through repository-supported workers; keep arbitrary persistence backends behind their existing read handles.

**Tech Stack:** TypeScript, Cordis effects and services, Node workers, SQLite FTS5/WAL, Vitest, existing Loader and recorded-session test support.

---

## Global constraints

- User approved approximately five seconds of normal-load historical synchronization latency. This is a target, not a guarantee during initial indexing or recovery.
- Never change active profile settings, switch the running entry point, start a replacement server, stop services, or restart services during this implementation.
- Work only in this isolated branch. Original session artifacts remain untouched; tests use private temporary roots and synthetic messages.
- Search ranking, filter semantics, workspace authorization, step cutoffs, cursor/snapshot behavior, and live preference remain intact.
- Distinguish empty results from incomplete coverage. Report scoped progress only; no unauthorized titles, identifiers, counts, or paths.
- Every background operation has an instance owner, cancellation, failure containment, and awaited teardown. Query cancellation does not cancel shared synchronization.
- Publish each session atomically after a source revision check. Preserve committed progress across interruption. Delete only after a successful complete enumeration. Hide known-changed or invalid generations until validated replacements commit.
- Worker messages validate their process boundary. Do not introduce a second raw session parser or bypass current format-catalog validation.

## Measurement card

User operation: first and repeated model-facing historical search, including an initially unindexed corpus and concurrent updates. Workload: deterministic synthetic corpus, varied session sizes, plus blocked reads to prove query independence. Entry path: actual SQLite service and model-facing tool; Loader/built worker integration where used. Clock: distinguish construction, synchronization, query and tool title/authorization work. Exclude model/network generation. Record baseline and candidate samples, memory where measured, runtime, and workload dimensions. Negative control: the blocked-read query test must fail against the original foreground path. Never substitute parse-and-discard timing for end-to-end search latency.

## Task 1: Establish regression and shared coverage API

**Files:** `packages/session-query/session-query/src/types.ts`, `packages/session-query/session-query/src/index.ts`, corresponding service tests, and this plan.

1. Run existing SQLite and tool tests before edits. Baseline: 177 tests passed in two files; preserve the command/result in the progress ledger.
2. Add `SessionSearchCoverage` and an optional `coverage` field on search pages. Fields: `state` (`initializing`, `syncing`, `ready`, `degraded`), optional `checkedAt`, optional scope-authorized `indexedSessions`, `pendingSessions`, and `failedSessions`. Absent coverage retains existing exact-provider semantics. Do not emit source failures or global counts in this object.
3. Add provider behavior tests with deferred promises that assert a background query settles before blocked persistence reads; observe failure before implementation. Avoid wall-clock correctness.
4. Verify type-level consumers and document freshness semantics beside the service definition.

## Task 2: Background provider with resumable publication

**Files:** `packages/session-query/session-query-sqlite/src/`, its tests and README pair.

1. Tests first: blocked initial/read/retry does not hold search, committed session remains available when a later read fails, known-changed data is hidden, interrupted scan does not delete, a query abort does not cancel the shared job, disposal waits or cancels owned work, scoped coverage cannot disclose other workspaces.
2. Add validated `syncMode: 'on-search' | 'background'` (default `on-search`), `syncIntervalMs` (default 5000), and `syncReadConcurrency` (default 2). Integrate lifecycle through Cordis effects. Keep existing on-search tests unchanged.
3. Synchronize outside the query serialization queue; perform only bounded atomic publication inside it. Coalesce requests and periodically reconcile while active. Check persistence identity and source revisions before committing. Retain prior committed generations and retry only pending/changed sources.
4. Scope coverage through request session predicates, and use the target session for event searches. Initial absence must not become a false SESSION_NOT_FOUND for a known pending target.
5. Run focused new tests, then the existing provider tests.

## Task 3: Off-thread preparation and disk index composition

**Files:** owning worker/persistence files determined by the worker integration audit; `packages/experimental/session-search/cordis.patch.yml`, relevant launcher context/test files only when necessary.

1. Reuse existing detached format-catalog and worker launch support. Read the exact owning interfaces before selecting a helper; do not make the generic query service import a JSONL implementation for path guessing.
2. Write built-entry tests for source validation, message validation, source-change cancellation and worker cleanup before implementation.
3. Keep index paths stable across reloads and isolated by profile, source root and logical service owner. Refuse unsupported/missing disk-path authority; never silently share writable indexes between live processes.
4. Validate cold/warm reopening against a temporary persistent root, and assert source artifacts are byte-identical.

## Task 4: Model-visible coverage and safe title enrichment

**Files:** `packages/experimental/tool-session-query/src/operations.ts`, `src/presentation.ts`, tests and README pair; recorded-session owner if output changes.

1. Test partial empty results do not render ordinary complete no-match text. Test ready results, partial matches, page aggregation, and omission of unauthorized progress.
2. Preserve coverage across collection of pages. Render concise stable freshness text without backend internals or source paths.
3. Avoid adding unrelated corpus reads during title enrichment. Honor permission checks before any title or snippet emission.
4. Run tool and SQLite integration tests, then the owning keyless recorded scenario.

## Task 5: Review and validation

1. Independent reviewers inspect spec compliance, errors, lifecycle ownership, security, and bounded resources. Fix material findings and rerun affected checks.
2. Run focused unit, Loader, worker and snapshot tests; measure synthetic before/after search work using equivalent endpoints.
3. Run the affected artifact build and then build check after the final code changes. Run focused lint and documentation checks; report exact exits and exclusions.
4. Review the complete final diff. Deliver branch, tests, performance evidence and deployment/rollback instructions. Do not claim this online GUI uses the new code.

## Progress ledger

- Isolated branch created from the current local checkout; online checkout and runtime settings unchanged.
- Offline frozen dependency installation completed successfully with lifecycle scripts disabled.
- Baseline command: `pnpm exec vitest run packages/session-query/session-query-sqlite/tests/sqlite.spec.ts packages/experimental/tool-session-query/tests/tool-session-query.spec.ts --maxWorkers=2`.
- Baseline result: exit 0, 177 tests passed, two files passed; elapsed 8.61 s. This is functional evidence, not a calibrated performance benchmark.
- Read-only query and worker audits completed. Confirmed search-time full-corpus reconciliation and a separate cold-title enrichment cost; no measurements yet establish the complete runtime cost split.
- Tool coverage TDD: four new tests failed against original rendering (exit 1), then passed after page aggregation and explicit incomplete-result rendering. Two additional deferred-title tests failed against cold enrichment (exit 1), then passed after background-mode title deferral.
- Interim focused command: `pnpm exec vitest run packages/experimental/tool-session-query/tests/tool-session-query.spec.ts packages/api/session-controller/tests/session-search.host.spec.ts --maxWorkers=2`; exit 0, 134 passed (108 tool, 26 Host search), two files passed. Host captured-pagination assertion failed before adding `snapshot: true`.
- Tool README bilingual pairing recorded with `pnpm exec tsx scripts/verify-translation-pairing.ts --write packages/experimental/tool-session-query/README.md` (exit 0).
- Background provider, provider-owned read worker, persistent single-owner protection, API references and initializing recorded-session coverage are implemented. Default on-search behavior and active service configuration remain unchanged.
- Scope clarification: model tools and the typed service support background coverage. The current Web content-search wire/client does not; its provider must stay in on-search mode. A trial Host rejection was removed because the Client hides errors as no matches. Snapshot pagination remains enabled for that consumer.
- Root review found two new regressions: live-only coverage counts were omitted, and worker-read memos lacked tail-repair metadata before a later write. Added failing tests, fixed counts/unknown initialization values, and forced write-lease revalidation. The provider and worker suites then passed 121 tests (89 plus 32), exit 0.
- Broader regression: 1043 passed, 11 skipped, one unmodified symlink fixture failed with Windows EPERM while creating the link (29 files, exit 1). This is not reported as all-green.
- Initial full artifact build passed, exit 0. Aggregate build check found one unused new test import; it is removed, but the final build/check must be rerun after the root fixes.
- Later child-agent execution and backend review failed because the configured child route auto/deepseek-v4-flash is unavailable. Earlier tool review completed; whole-backend automated review did not. Root source review and validation continue, without treating the interrupted review as passing.
- Remaining validation: final artifacts/check, built-worker/Loader smoke, synthetic measurements, documentation/lint checks and final diff. FTS publication and document preparation still run on the calling thread; only cold decoding is currently offloaded. No complete off-thread index-publication claim is made.
