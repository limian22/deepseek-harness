---
description: "The SQLite FTS5 full-text search backend for session history, for deployments and maintainers choosing, configuring, or debugging full-text search over the query service."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query-sqlite

English | [中文](README.zh.md)

## Summary

Add ranked SQLite FTS5 search across or within sessions with cursor pagination. Live and persisted history use a separate, single-owner derived index without changing source logs; exact reads, filters and traces remain available. Search is opt-in, with startup, first-search or disabled opening. Matches are tokens and phrases, not arbitrary substrings. The default `on-search` mode reconciles before answering; `syncMode: background` returns indexed history immediately, synchronizes in an owned background task and reports freshness through `coverage`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package when a composition needs ranked full-text search over session history — for example the Web content search or `/resume` prior-work retrieval. The common path is explicit: mount the plugin, give it a dedicated database path, and call `ctx.sessionQuery.searchSessions` or `searchEvents` from code.

### When to choose it

Choose it when you want full-text recall over prior sessions with ranking and paging. Choose it together with `dsh-session-query` and the session service; a persistence backend is optional but recommended so persisted history is searchable after restarts. Avoid pointing `path` at the session-persistence database — this package owns a separate derived index. Choose `syncMode: background` when a caller must not wait for a full durable listing, such as a model-facing search over a large corpus.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/session-search.db
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | Dedicated derived-index SQLite path, or `:memory:`; missing paths are created owner-only on POSIX |
| `openAt` | `startup` | `startup` opens at activation; `first-search` defers the SQLite module until the first search; `never` disables full-text search while inherited reads stay available |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist` |
| `defaultLimit` | `20` | Page size when a request omits `limit` |
| `maxLimit` | `100` | Largest accepted request page size |
| `snippetChars` | `240` | Maximum snippet length in Unicode code points |
| `readWindowMax` | `50` | Maximum `before`/`after` raw events for the inherited `readEvent()` |
| `persistedReadConcurrency` | `4` | Concurrent persisted-log reads for inherited batch reads |
| `preparedSessionCacheSize` | `5` | Cold prepared-Session observations the inherited `observeSession` reader retains for reuse |
| `syncMode` | `on-search` | `on-search` reconciles the complete durable source inside every search and reports no coverage; `background` returns indexed history immediately, reconciles on an owned background job, and reports coverage |
| `syncIntervalMs` | `5000` | Interval between background reconciliations; at most `2^31 - 1`, Node's maximum timer delay |
| `syncReadConcurrency` | `2` | Concurrent cold-log reads in one background reconciliation |
| `syncBatchSessions` | `24` | Validated sessions committed per background transaction |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-query-sqlite) is the exhaustive source for every accepted field and its JSDoc.

### Search behavior

`searchSessions` searches the whole corpus and groups results by each session's strongest matching event; `searchEvents` searches one logical session. Queries are literal phrases: they are trimmed and whitespace-normalized, and FTS5 syntax such as quotes, `OR`, `NEAR`, and `*` is treated as data, never as executable query syntax. Metadata filters (session id, cwd, created-at, parent, availability, event seq/time/type/surface) narrow results before ranking. All `current`, `shadowed`, and `log-only` events are searchable by default; pass a surface filter to narrow.

Ranking is deterministic: more actual FTS5 highlighted-match spans first, then shorter documents, with event time, session id, and seq breaking ties. Results carry plain-text snippets bounded by `snippetChars` Unicode code points, with no provider-specific numeric score. Pages continue through an opaque `SessionSearchCursor` bound to the exact normalized request; a cursor becomes stale when its relevant corpus changes (`SESSION_QUERY_STALE_CURSOR`), and a within-session cursor survives changes to unrelated sessions while a cross-session cursor does not.

A caller that reads several pages while other sessions keep writing can pass `snapshot: true`. The first page captures the complete ranking (at most 500 hits) and returns a snapshot cursor, so later pages read that capture and concurrent writes never invalidate the rest of the search. A capture stays continuable for two minutes, and each scope retains at most eight captures and 32 MiB of hits; expired or evicted captures fail with `SESSION_QUERY_STALE_CURSOR` exactly like a changed corpus. A result set larger than the cap falls back to generation-bound cursors instead of silently truncating.

The `unicode61` tokenizer matches tokens and phrases, not arbitrary substrings: `AI` does not match the token `BRAID`. Use `ctx.sessionQuery.filterEvents()` with a `text` clause when a literal whitespace-flexible substring scan is required.

### Background synchronization

With `syncMode: background`, a search never waits for a durable listing or a cold-log read. It answers from the current derived index and asks an owned background job to reconcile the source; the same job reconciles every `syncIntervalMs` while the service is active, coalescing overlapping requests. Validated sessions are committed in bounded batches (`syncBatchSessions`, one transaction and one generation step per batch) and the derived index runs in `synchronous = NORMAL` because it is rebuildable, which keeps commit cost off the per-session path; an interrupted batch is re-read on the next pass. A generation whose source revision changed is hidden until its validated replacement commits, and a session is deleted only after a complete successful listing omits it. With `openAt: first-search`, background synchronization starts at the first search rather than at activation.

Searches refresh the live session index before returning. For an existing live session, the refresh retains FTS rows whose event surface is unchanged and writes only new documents and changed surfaces. A newly attached live session still needs an initial index build.

Every background page carries `coverage`, computed over all of the request's session predicates: `state` is `initializing` until the index is verified against the current source, `syncing` while a scan runs or listed sessions await a read, `degraded` after an isolated source failure, and `ready` once the enumerable corpus is indexed. `checkedAt` is the last successful complete observation. `indexedSessions`, `pendingSessions`, and `failedSessions` are scoped counts that never include sessions outside the request's filters. Counts are omitted before enumeration establishes the scope; verified counts include searchable live-only sessions without double-counting their persisted bases. A captured pagination keeps its first-page coverage, so a continuation never reports fresher state than its capture, and `on-search` pages carry no coverage.

On reopening a persistent index, persisted hits stay hidden until one complete listing verifies the current source metadata, so a replaced source never serves the previous store's rows; if that check cannot complete, the state remains `initializing` rather than a false `ready`. A within-session search for a listed source whose generation is still pending returns that session's header with an empty page and a `syncing` or `degraded` coverage state instead of `SESSION_QUERY_SESSION_NOT_FOUND`; only an id the source never listed fails that way.

### When to defer or disable search

With `openAt: first-search`, the service activates without importing `node:sqlite` or opening the index, deferring SQLite's experimental warning until the first actual search; an invalid database fails that first search instead of service activation. With `openAt: never`, full-text search is off for the deployment: `searchSessions` and `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` before any request normalization, while every inherited exact read, filter, and trace keeps working. Requests that exceed the compiled-predicate budget (14 combined predicates across sessions, 13 within a session) or SQLite's portable 32,766-binding limit fail with `SESSION_QUERY_INVALID_FILTER` before statement preparation.

### Failures and recovery

Typed `SessionQueryError` failures carry stable codes: `SESSION_QUERY_SEARCH_DISABLED` when search is configured off; `SESSION_QUERY_INDEX_FAILED` when the index cannot open or reconcile; `SESSION_QUERY_SESSION_NOT_FOUND` when a search target is absent; `SESSION_QUERY_STALE_CURSOR` when the corpus changed between pages or a capture expired — retry the complete search call; and `SESSION_QUERY_INVALID_CURSOR` for a cursor that does not belong to this request. Cancellation is honored between synchronous SQLite calls; a statement already executing on the JavaScript thread cannot be interrupted.

Opening an index path that another process or service instance already owns fails with `SESSION_QUERY_INDEX_FAILED`, naming the index path, the ownership sidecar, and the claim's instance identifier, and asking for a distinct `path` per profile and persistence source. The claim is released when the service closes, and the operating system releases it when the owning process exits.

In background mode a source or read failure does not fail the search: it is contained, counted in the scoped `failedSessions`, and retried by the next reconciliation, while the page stays available with `degraded` coverage. Aborting one search cancels only that caller; the shared synchronization job and its lifetime cancellation are owned by the instance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The backend is built on one separation and three commitments:

- **Derived index, never the source store.** The FTS rows live in a dedicated disposable database; the session-persistence database is never opened here.
- **Live-preferred observation.** One serialized state machine compares persistence snapshot revisions, reads only new or changed logs through short-lived read handles, and reconciles in one transaction, so a search reflects the newest stable state.
- **Generation-bound cursors.** Every corpus change bumps a generation; cursors carry the generation they were created under and fail stale rather than returning a shifted page.
- **Opt-in captured pagination.** A `snapshot: true` search captures its ranking once, so a caller reading several pages is not invalidated by writes elsewhere; captures are bounded by age, count, and bytes, and an oversized result set keeps the generation-bound behavior.
- **Literal phrases as data.** Caller query text is quoted into one FTS5 phrase so query syntax stays inert, and reserved highlight markers are stripped from documents before indexing.

The design history lives in the [SQLite FTS5 session search note](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md) and the [unified service decision](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: config, openAt lifecycle, on-search reconciliation, background synchronization, query execution, cursors |
| [`src/query.ts`](src/query.ts) | Request normalization, parameterized predicates, snippets, predicate and binding budgets |
| [`src/schema.ts`](src/schema.ts) | Database schema, application-id ownership, ownership claim, in-place reset, owner-only file creation |
| [`src/ownership.ts`](src/ownership.ts) | Cross-process derived-index ownership through a dedicated sidecar database |
| [`src/snapshots.ts`](src/snapshots.ts) | Bounded captured rankings for multi-page searches |

### Index lifecycle

Persisted FTS rows live in a dedicated derived database and survive restarts; live sessions use connection-local TEMP tables that shadow the durable base for the same session and reveal it again when the live owner detaches. Both tables retain the exact inherited cut in numeric `seed_length`; reconstructed headers expose only `isSeeded`, while the cut participates in live fingerprints and persisted source revisions. Each on-search search runs one serialized observation: list persistence snapshots, compare per-session revisions with the indexed rows, read only new or changed logs through a read handle (balancing an interrupted final turn in memory, never writing back), extract semantic documents, and commit the reconciliation in one transaction before running the query. Repeated queries and unchanged reopens read nothing; switching stores or observing new, changed, deleted, or externally repaired sources reconciles on the next stable observation. Source or transaction failure commits nothing and the next search retries.

Background mode keeps the same tables and live overlay but moves the observation off the query path. A scan lists persistence snapshots without holding the query serializer, publishes only bounded changes in one transaction (hiding generations whose source revision changed, deleting what a complete listing no longer contains, and recording listed-but-unread sources in the `sync_sessions` ledger with their revision and state), then reads pending sessions concurrently outside the serializer and commits each one atomically after rechecking its source revision. A live-owned session is never cold-read while its owner exists; it keeps the TEMP overlay and is read after the owner detaches. A reopened or replaced source withholds persisted rows until one complete listing verifies the current source metadata. `whenSynchronized()` resolves when no scan is running or requested, which lets a caller wait for a freshness barrier instead of polling coverage.

### Schema ownership

The database carries an application id and schema version 9, which adds the `sync_sessions` ledger beside the persisted and live tables. Opening refuses a file owned by another application or a canonical database, rejects unknown user tables, and only a recognized incompatible derived schema resets in place — so an unrelated or session-persistence database is never touched. On POSIX filesystems, missing directories and database files are created owner-only (`0700` and `0600` before the process umask). Each path is claimed through a `<path>.owner.sqlite` sidecar opened in SQLite's exclusive locking mode: exactly one service in one process owns a derived-index path, the main database stays readable under WAL by other connections, a second claim fails with a diagnosable error, and the operating system releases the claim when the owning process exits. The sidecar is never deleted. Generations and TEMP shadow state are connection-owned.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared query service to the type-level contract and the design evidence.

- [Session Query subsystem reference](../../../docs/subsystems/session-query.md) — the full type-level contract this backend implements.
- [dsh-session-query](../session-query/README.md) — the service definition: exact reads, filters, and traces this backend inherits.
- [dsh-tool-session-query](../../experimental/tool-session-query/README.md) — the model-facing consumer that calls these search methods.
- [SQLite FTS5 session search](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md) — search semantics, reconciliation, and the tokenizer decision.
- [JSONL session persistence](../../session/session-persistence-jsonl/README.md) — the authoritative Session store this disposable index observes; keep its root separate from this package's database path.

-----

<a id="model-experience"></a>
## Model Experience

None, as the search backend returns hits only to callers and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a general SQLite comparison or a task backlog.

- **No caller authorization** — this is a trusted context-wide service; a model tool or UI must enforce its own access policy.
- **Coverage describes the provider-enumerable corpus** — a persistence backend may omit artifacts it cannot classify, such as unsupported or corrupt headers in JSONL listings. Those artifacts are never indexed, are not counted in `failedSessions`, and `ready` claims only that every session the backend enumerates is synchronized; it makes no claim about every artifact on disk.
- **Background freshness is a target, not a guarantee** — `syncIntervalMs` bounds the reconciliation cadence during normal load, but initial indexing and recovery take as long as the corpus requires. A caller that needs exact search-time reconciliation keeps `on-search`.
- **Index publication runs on the JavaScript thread** — background scans read through persistence read handles, but document extraction and the SQLite commit still run on the JavaScript thread; only a backend's own cold-read path can move decode work off-thread.
- **Synchronous query execution** — `DatabaseSync` blocks the JavaScript thread during MATCH execution and cannot interrupt a statement already running.
- **Token recall, not arbitrary substrings** — the `unicode61` tokenizer does not match substrings inside a larger token; use `filterEvents()` for literal scans.
- **Captured pagination is process-local and bounded** — a capture is not shared across processes or restarts, expires after two minutes, and holds at most 500 hits; wider result sets keep generation-bound cursors.
- **Single-owner derived index** — one service in one process must own each index path; a second owner is refused, and external writers or multi-process sharing of the index are unsupported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: alternate tokenizers and search providers

The `unicode61` tokenizer choice trades substring recall for index size and two-character token support; the trigram alternative was measured and rejected. Switching tokenizers or adding another search backend would change indexed recall and require its own reconciliation and generation story. Moving index publication to a worker would need its own measured boundary; the generic query contract assumes no specific thread.

</details>
