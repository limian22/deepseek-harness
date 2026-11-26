/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { scheduler } from 'node:timers/promises'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  ColdSessionLog,
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionResultFilter,
  SessionSearchCoverage,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  SESSION_QUERY_SNAPSHOT_MAX_ROWS,
  SnapshotStore,
  type SearchSnapshot,
} from './snapshots.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  sanitizeFtsText,
  segmentHan,
  SQLITE_MAX_PAGE_LIMIT,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'
export {
  SESSION_QUERY_SNAPSHOT_MAX_BYTES,
  SESSION_QUERY_SNAPSHOT_MAX_ENTRIES,
  SESSION_QUERY_SNAPSHOT_MAX_ROWS,
  SESSION_QUERY_SNAPSHOT_TTL_MS,
  type SnapshotLimits,
} from './snapshots.ts'

/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240
/** Default interval between background source reconciliations, in milliseconds. */
export const SESSION_QUERY_SQLITE_DEFAULT_SYNC_INTERVAL_MS = 5000
/** Default concurrent cold-log reads in background synchronization. */
export const SESSION_QUERY_SQLITE_DEFAULT_SYNC_READ_CONCURRENCY = 2
/** Default validated sessions committed per background transaction. */
export const SESSION_QUERY_SQLITE_DEFAULT_SYNC_BATCH_SESSIONS = 24

// One transient source change gets a retry; repeated churn fails rather than monopolizing the queue.
const STABLE_OBSERVATION_ATTEMPTS = 2

/** Node's maximum timer delay in milliseconds; longer intervals clamp to 1 ms. */
const MAX_SYNC_INTERVAL_MS = 2 ** 31 - 1

/** How searches relate to durable source reconciliation. */
export type SyncMode = 'on-search' | 'background'

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
  /**
   * When durable history is reconciled relative to searches. `on-search`
   * reconciles the complete source inside every search and reports no
   * coverage. `background` returns indexed history immediately, reconciles on
   * an owned background job, and reports freshness through `coverage`.
   * Defaults to `on-search`.
   */
  syncMode?: SyncMode
  /** Interval between background reconciliations in milliseconds. At most 2147483647 (Node's maximum timer delay); defaults to 5000. */
  syncIntervalMs?: number
  /** Concurrent cold-log reads in one background reconciliation. At most `Number.MAX_SAFE_INTEGER`; defaults to 2. */
  syncReadConcurrency?: number
  /**
   * Validated sessions committed per background transaction. Larger batches cut
   * commit/fsync overhead on a large first index; each batch still verifies every
   * session's source revision before publishing, and an interrupted batch is
   * simply re-read on the next pass. Defaults to 24.
   */
  syncBatchSessions?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
  syncMode: SyncMode
  syncIntervalMs: number
  syncReadConcurrency: number
  syncBatchSessions: number
}

interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
  fingerprint: string
}

interface LiveIndexedDocument {
  readonly rowid: number | bigint
  readonly surface: SessionEventSearchDocument['surface']
}

interface LivePublication {
  readonly seq: SessionLogOffset
  readonly fingerprint: string
  readonly documents: ReadonlyMap<SessionSeq, LiveIndexedDocument>
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: ObservedSession
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  persisted: Map<SessionId, ObservedPersistedSession>
  live: Map<SessionId, ObservedSession>
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

/** Searchable content validated for one durable source generation. */
interface SessionPublication {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
}

/** One listed source generation that background synchronization must read. */
interface SyncWorkItem {
  id: SessionId
  revision: SessionPersistenceRevision
  header: SessionHeader
}

/** Sync ledger state stored for a listed source that is not searchable yet. */
type SyncRowState = 'live' | 'pending' | 'failed'

/** Ledger columns needed to answer for a pending target without reading its log. */
interface SyncHeaderRow {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seeded: number
  delegation_depth: number | null
  agent_preset: string | null
  revision: string
}

/** Scoped session counts derived from indexed and pending rows. */
interface ScopedCoverageCounts {
  indexed: number
  pending: number
  failed: number
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

interface SnapshotCursorPayload {
  version: 2
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  snapshot: string
  offset: number
}

interface SnapshotContinuation {
  readonly snapshot: string
  readonly offset: number
}

/** Parsed cursor payload; the shape decides which continuation kind it is. */
type CursorPayloadValue =
  & Omit<Partial<CursorPayload>, 'version'>
  & Omit<Partial<SnapshotCursorPayload>, 'version'>
  & { version?: unknown }

/** Snapshot metadata binding a captured event ranking to its target session and coverage. */
interface EventSnapshotMeta {
  session: SessionHeader
  coverage?: SessionSearchCoverage
}

/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
    preparedSessionCacheSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    syncMode: z.union(['on-search', 'background'] as const).default('on-search'),
    syncIntervalMs: z.number()
      .step(1)
      .min(1)
      .max(MAX_SYNC_INTERVAL_MS)
      .default(SESSION_QUERY_SQLITE_DEFAULT_SYNC_INTERVAL_MS),
    syncReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_SQLITE_DEFAULT_SYNC_READ_CONCURRENCY),
    syncBatchSessions: z.number()
      .step(1)
      .min(1)
      .max(10_000)
      .default(SESSION_QUERY_SQLITE_DEFAULT_SYNC_BATCH_SESSIONS),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _releaseOwnership: (() => Promise<void>) | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private readonly _liveObservations = new WeakMap<Session, LivePublication>()
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _optionalPersistenceFiber: Fiber
  private readonly _sessionSnapshots = new SnapshotStore<SessionSearchHit, SessionSearchCoverage | undefined>()
  private readonly _eventSnapshots = new SnapshotStore<SessionEventSearchHit, EventSnapshotMeta>()
  private _syncBinding: symbol | undefined
  private _syncVerified = false
  private _syncCheckedAt: number | undefined
  private _syncListingFailed = false
  private _syncScanFailed = false
  private _syncRequested = false
  private _syncDraining = false
  private _syncWork: Promise<void> = Promise.resolve()
  private _syncAbort: AbortController | undefined
  private _syncTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._invalidateSnapshots()
      this._persistenceBinding = binding
      this._requestSync()
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._invalidateSnapshots()
        this._persistenceBinding = { identity: Symbol() }
        this._requestSync()
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => async () => this._stopBackgroundSync(), 'sessionQuerySqlite.backgroundSync')
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected override async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') {
      await this._ensureReady(undefined)
      this._startBackgroundSync()
    }
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    if (this.config.syncMode === 'background') return this._backgroundSessions(normalized, signal)
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const fingerprint = requestFingerprint(normalized)
      const payload = normalized.cursor === undefined ? undefined : parseCursor(normalized.cursor)
      const continuation = payload === undefined
        ? undefined
        : snapshotContinuation(payload, this._instance, 'sessions', fingerprint)
      if (continuation !== undefined) {
        const snapshot = this._sessionSnapshots.take(continuation.snapshot)
        if (snapshot === undefined) throw staleSnapshot()
        return snapshotPage(snapshot, this._instance, 'sessions', continuation.offset, normalized.limit)
      }
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      if (normalized.snapshot && payload === undefined) {
        const captured = this._querySessions(normalized, 0, persistenceBinding, SESSION_QUERY_SNAPSHOT_MAX_ROWS)
        if (captured.length <= SESSION_QUERY_SNAPSHOT_MAX_ROWS) {
          const snapshot = this._sessionSnapshots.store(
            fingerprint,
            captured.map(row => this._sessionHit(row)),
            undefined,
          )
          if (snapshot !== undefined) {
            return snapshotPage(snapshot, this._instance, 'sessions', 0, normalized.limit)
          }
        }
      }
      const generation = String(this._globalGeneration)
      const offset = payload === undefined
        ? 0
        : decodeCursor(payload, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    if (this.config.syncMode === 'background') return this._backgroundEvents(normalized, signal)
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const fingerprint = requestFingerprint(normalized)
      const payload = normalized.cursor === undefined ? undefined : parseCursor(normalized.cursor)
      const continuation = payload === undefined
        ? undefined
        : snapshotContinuation(payload, this._instance, 'events', fingerprint)
      if (continuation !== undefined) {
        const snapshot = this._eventSnapshots.take(continuation.snapshot)
        if (snapshot === undefined) throw staleSnapshot()
        return {
          session: snapshot.meta.session,
          ...snapshotPage(snapshot, this._instance, 'events', continuation.offset, normalized.limit),
        }
      }
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      if (normalized.snapshot && payload === undefined) {
        const captured = this._queryEvents(normalized, 0, persistenceBinding, SESSION_QUERY_SNAPSHOT_MAX_ROWS)
        if (captured.length <= SESSION_QUERY_SNAPSHOT_MAX_ROWS) {
          const snapshot = this._eventSnapshots.store(
            fingerprint,
            captured.map(row => this._eventHit(row)),
            { session: target.header },
          )
          if (snapshot !== undefined) {
            return {
              session: target.header,
              ...snapshotPage(snapshot, this._instance, 'events', 0, normalized.limit),
            }
          }
        }
      }
      const offset = payload === undefined
        ? 0
        : decodeCursor(payload, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Resolve once no background reconciliation is running or requested.
   *
   * A caller that needs a freshness barrier — graceful shutdown, an integration
   * test, or an external handoff — awaits this instead of polling coverage.
   * On-search mode is always quiescent.
   * @returns resolution when the owned background job is idle.
   */
  async whenSynchronized(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const work = this._syncWork
      await work
      if (this._syncWork === work && !this._syncRequested) return
    }
    throw new SessionQueryError(
      'session-search background synchronization did not quiesce',
      'SESSION_QUERY_INDEX_FAILED',
    )
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _close(): Promise<void> {
    this._closed = true
    await this._stopBackgroundSync()
    await this._tail
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._sessionSnapshots.clear()
    this._eventSnapshots.clear()
    try {
      this._db?.close()
    } finally {
      // Release the ownership claim even when closing the index connection
      // fails, so the path is never held until process exit.
      this._db = undefined
      const release = this._releaseOwnership
      this._releaseOwnership = undefined
      await release?.()
    }
  }

  private async _open(): Promise<void> {
    const opened = await openSearchDatabase(this.config.path, this.config.journalMode)
    this._db = opened.db
    this._releaseOwnership = () => opened.release()
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._open()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      // Ownership and schema refusals already carry a typed code and cause.
      if (error instanceof SessionQueryError) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => T | Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _backgroundSessions(
    normalized: NormalizedSessionRequest,
    signal: AbortSignal | undefined,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      this._startBackgroundSync()
      const persistenceBinding = this._adoptBackgroundSource()
      this._publishLiveOverlay(persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const payload = normalized.cursor === undefined ? undefined : parseCursor(normalized.cursor)
      const continuation = payload === undefined
        ? undefined
        : snapshotContinuation(payload, this._instance, 'sessions', fingerprint)
      if (continuation !== undefined) {
        const snapshot = this._sessionSnapshots.take(continuation.snapshot)
        if (snapshot === undefined) throw staleSnapshot()
        const coverage = snapshot.meta
        return {
          ...snapshotPage(snapshot, this._instance, 'sessions', continuation.offset, normalized.limit),
          ...coverage === undefined ? {} : { coverage },
        }
      }
      if (normalized.snapshot && payload === undefined) {
        const captured = this._querySessions(
          normalized,
          0,
          persistenceBinding,
          SESSION_QUERY_SNAPSHOT_MAX_ROWS,
        )
        if (captured.length <= SESSION_QUERY_SNAPSHOT_MAX_ROWS) {
          const coverage = this._sessionSearchCoverage(normalized)
          const snapshot = this._sessionSnapshots.store(
            fingerprint,
            captured.map(row => this._sessionHit(row)),
            coverage,
          )
          if (snapshot !== undefined) {
            return {
              ...snapshotPage(snapshot, this._instance, 'sessions', 0, normalized.limit),
              coverage,
            }
          }
        }
      }
      const generation = String(this._globalGeneration)
      const offset = payload === undefined
        ? 0
        : decodeCursor(payload, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return {
        ...page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'sessions',
          fingerprint,
          generation,
          offset: cursorOffset,
        }), offset),
        coverage: this._sessionSearchCoverage(normalized),
      }
    })
  }

  private async _backgroundEvents(
    normalized: NormalizedEventRequest,
    signal: AbortSignal | undefined,
  ): Promise<SessionEventSearchPage> {
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      this._startBackgroundSync()
      const persistenceBinding = this._adoptBackgroundSource()
      this._publishLiveOverlay(persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const payload = normalized.cursor === undefined ? undefined : parseCursor(normalized.cursor)
      const continuation = payload === undefined
        ? undefined
        : snapshotContinuation(payload, this._instance, 'events', fingerprint)
      if (continuation !== undefined) {
        const snapshot = this._eventSnapshots.take(continuation.snapshot)
        if (snapshot === undefined) throw staleSnapshot()
        const { coverage } = snapshot.meta
        return {
          session: snapshot.meta.session,
          ...snapshotPage(snapshot, this._instance, 'events', continuation.offset, normalized.limit),
          ...(coverage === undefined ? {} : { coverage }),
        }
      }
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      if (normalized.snapshot && payload === undefined) {
        const captured = this._queryEvents(
          normalized,
          0,
          persistenceBinding,
          SESSION_QUERY_SNAPSHOT_MAX_ROWS,
        )
        if (captured.length <= SESSION_QUERY_SNAPSHOT_MAX_ROWS) {
          const coverage = this._eventSearchCoverage(normalized.sessionId)
          const snapshot = this._eventSnapshots.store(
            fingerprint,
            captured.map(row => this._eventHit(row)),
            { session: target.header, coverage },
          )
          if (snapshot !== undefined) {
            return {
              session: target.header,
              ...snapshotPage(snapshot, this._instance, 'events', 0, normalized.limit),
              coverage,
            }
          }
        }
      }
      const offset = payload === undefined
        ? 0
        : decodeCursor(payload, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
        coverage: this._eventSearchCoverage(normalized.sessionId),
      }
    })
  }

  /**
   * Adopt the currently mounted persistence source for background
   * synchronization. A changed source identity hides every generation indexed
   * for the previous source and withholds the index until the first complete
   * metadata check, so a reopened or replaced source never serves another
   * store's rows.
   * @returns the adopted persistence binding.
   */
  private _adoptBackgroundSource(): PersistenceBinding {
    const binding = this._persistenceBinding
    if (this._syncBinding === binding.identity) return binding
    const previous = this._syncBinding
    this._syncBinding = binding.identity
    this._syncVerified = false
    this._syncCheckedAt = undefined
    this._syncListingFailed = false
    this._syncScanFailed = false
    if (previous !== undefined) {
      this._persistenceEpoch += 1
      this._clearIndexedContent()
    }
    this._requestSync()
    return binding
  }

  private _invalidateSnapshots(): void {
    this._sessionSnapshots.clear()
    this._eventSnapshots.clear()
  }

  private _clearIndexedContent(): void {
    const db = this._requireDb()
    const present = db.prepare(`
      SELECT (SELECT COUNT(*) FROM persisted_sessions) + (SELECT COUNT(*) FROM sync_sessions) AS rows
    `).get() as { rows: number }
    if (present.rows === 0) return
    let next = this._globalGeneration
    this._transaction(() => {
      db.exec('DELETE FROM persisted_docs')
      db.exec('DELETE FROM persisted_sessions')
      db.exec('DELETE FROM sync_sessions')
      next = this._mainGeneration() + 1
      db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(next)
    })
    this._globalGeneration += 1
    this._localGeneration = Math.max(this._localGeneration, next)
  }

  /**
   * Keep the connection-local live rows exactly as an on-search reconciliation
   * would, without reading any durable source: live content stays preferred,
   * shadows a persisted base of the same id, and reveals it again on detach.
   * @param binding - adopted persistence binding whose listed ids define `persisted`.
   */
  private _publishLiveOverlay(binding: PersistenceBinding): void {
    const db = this._requireDb()
    const indexed = liveIndexRows(db)
    const knownSources = this._knownSourceIds(binding)
    const activeIds = new Set<SessionId>()
    const changes = this.ctx.sessions.list().flatMap((session) => {
      activeIds.add(session.id)
      const row = indexed.get(session.id)
      const persisted = Number(knownSources.has(session.id))
      const cached = this._liveObservations.get(session)
      const previous = cached?.fingerprint === row?.fingerprint ? cached : undefined
      const seq = session.seq
      if (previous?.seq === seq && row?.persisted === persisted) return []
      // oxlint-disable-next-line typescript/no-deprecated -- Full fold preserves the search surfaces of earlier events.
      const documents = previous?.seq === seq ? undefined : buildSessionEventSearchDocuments(session.id, session.snapshotEvents())
      return [{ session, previous, seq, persisted, documents, fingerprint: randomUUID() }]
    })
    const deletes = [...indexed.values()].filter(row => !activeIds.has(row.id as SessionId))
    if (changes.length === 0 && deletes.length === 0) return
    const main = this._mainGeneration()
    let nextLocal = this._localGeneration
    const publications: Array<{ session: Session; publication: LivePublication }> = []
    this._transaction(() => {
      for (const row of deletes) this._deleteSession('live', row.id as SessionId)
      for (const { session, previous, seq, persisted, documents, fingerprint } of changes) {
        nextLocal = Math.max(nextLocal, main) + 1
        if (previous === undefined && indexed.has(session.id)) this._deleteSession('live', session.id)
        this._upsertLiveHeader(session.header, session.inheritedEventCount, fingerprint, persisted, nextLocal)
        const indexedDocuments = documents === undefined && previous !== undefined
          ? previous.documents
          : this._publishLiveDocuments(documents ?? [], previous?.documents)
        publications.push({ session, publication: { seq, fingerprint, documents: indexedDocuments } })
      }
    })
    for (const { session, publication } of publications) this._liveObservations.set(session, publication)
    this._localGeneration = nextLocal
    this._globalGeneration += 1
  }

  private _knownSourceIds(binding: PersistenceBinding): Set<SessionId> {
    const ids = new Set<SessionId>()
    if (!this._persistedContentVisible(binding)) return ids
    const db = this._requireDb()
    for (const row of db.prepare('SELECT id FROM persisted_sessions').all() as Array<{ id: string }>) {
      ids.add(row.id as SessionId)
    }
    for (const row of db.prepare('SELECT id FROM sync_sessions').all() as Array<{ id: string }>) {
      ids.add(row.id as SessionId)
    }
    return ids
  }

  private _persistedContentVisible(binding: PersistenceBinding): boolean {
    if (binding.service === undefined) return false
    return this.config.syncMode === 'background' ? this._syncVerified : true
  }

  private _transaction(operation: () => void): void {
    const db = this._requireDb()
    let began = false
    try {
      db.exec('BEGIN IMMEDIATE')
      began = true
      operation()
      db.exec('COMMIT')
    } catch (error: unknown) {
      /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the wrapper still reports it. */
      if (began) {
        /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
        try {
          db.exec('ROLLBACK')
        } catch {
          // The original SQLite failure remains the actionable cause.
        }
      }
      throw new SessionQueryError(
        `session-search index update failed: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private _startBackgroundSync(): void {
    if (this.config.syncMode !== 'background' || this.config.openAt === 'never' || this._closed) return
    if (this._syncAbort !== undefined) {
      this._requestSync()
      return
    }
    const controller = new AbortController()
    this._syncAbort = controller
    this._syncTimer = setInterval(() => { this._requestSync() }, this.config.syncIntervalMs)
    this._syncTimer.unref()
    this._requestSync()
  }

  private async _stopBackgroundSync(): Promise<void> {
    const controller = this._syncAbort
    if (controller === undefined) return
    controller.abort()
    if (this._syncTimer !== undefined) {
      clearInterval(this._syncTimer)
      this._syncTimer = undefined
    }
    this._syncRequested = false
    await this._syncWork
  }

  /**
   * Coalesce a background reconciliation request. Requests that arrive while
   * a scan runs fold into one follow-up scan; requests before readiness defer
   * to the readiness boundary that owns opening.
   */
  private _requestSync(): void {
    if (this.config.syncMode !== 'background' || this._closed) return
    const controller = this._syncAbort
    if (controller === undefined || controller.signal.aborted) return
    if (this._ready === undefined) return
    this._syncRequested = true
    if (this._syncDraining) return
    this._syncDraining = true
    this._syncWork = this._drainSync(controller).finally(() => {
      this._syncDraining = false
      if (this._syncRequested) this._requestSync()
    })
  }

  private _syncCancelled(signal: AbortSignal): boolean {
    return signal.aborted || this._isClosed()
  }

  private async _drainSync(controller: AbortController): Promise<void> {
    while (this._syncRequested && !this._syncCancelled(controller.signal)) {
      this._syncRequested = false
      try {
        await this._syncOnce(controller)
      } catch (_error: unknown) {
        // A failed scan leaves prior committed generations intact; coverage degrades.
        if (this._syncCancelled(controller.signal)) return
        this._syncScanFailed = true
      }
    }
  }

  private async _syncOnce(controller: AbortController): Promise<void> {
    const signal = controller.signal
    await this._ensureReady(undefined)
    if (this._syncCancelled(signal)) return
    const binding = await this._serialized(signal, () => this._adoptBackgroundSource())
    if (this._syncCancelled(signal)) return
    {
      const persistence = binding.service
      if (persistence === undefined) {
        await this._serialized(signal, () => {
          this._syncVerified = true
          this._syncCheckedAt = Date.now()
          this._syncListingFailed = false
          this._syncScanFailed = false
        })
        return
      }
      let listed: readonly SessionPersistenceSnapshot[]
      try {
        listed = await persistence.list({ signal })
      } catch (_error: unknown) {
        if (this._syncCancelled(signal)) return
        await this._serialized(signal, () => { this._syncListingFailed = true })
        return
      }
      if (this._syncCancelled(signal)) return
      let snapshots: Map<SessionId, ObservedPersistedSession>
      try {
        snapshots = materializePersistenceSnapshots(listed)
      } catch (_error: unknown) {
        if (this._syncCancelled(signal)) return
        await this._serialized(signal, () => { this._syncListingFailed = true })
        return
      }
      if (this._syncCancelled(signal)) return
      const work = await this._serialized(
        signal,
        () => this._planBackgroundSync(binding, snapshots, signal),
      )
      if (this._syncCancelled(signal)) return
      await this._runSyncReads(persistence, work, signal)
    }
  }

  /**
   * Publish the bounded result of one complete listing: hide generations whose
   * source changed, drop rows a complete listing no longer contains, record
   * listed-but-unindexed sources, and return the reads this scan must perform.
   * @param binding - binding the listing belongs to.
   * @param listed - complete listing snapshots keyed by session id.
   * @param signal - the synchronization lifetime signal.
   * @returns source generations that still need a read.
   */
  private _planBackgroundSync(
    binding: PersistenceBinding,
    listed: ReadonlyMap<SessionId, ObservedPersistedSession>,
    signal: AbortSignal,
  ): SyncWorkItem[] {
    if (signal.aborted || this._persistenceBinding.identity !== binding.identity) return []
    const db = this._requireDb()
    const committedRows = db.prepare('SELECT id, revision FROM persisted_sessions').all() as Array<{
      id: string
      revision: string
    }>
    const ledgerRows = db.prepare('SELECT id, revision, state, attempts, observed_at FROM sync_sessions').all() as Array<{
      id: string
      revision: string
      state: SyncRowState
      attempts: number
      observed_at: number
    }>
    const committed = new Map(committedRows.map(row => [row.id as SessionId, row.revision]))
    const ledger = new Map(ledgerRows.map(row => [row.id as SessionId, row]))
    const liveOwned = new Set(this.ctx.sessions.list().map(session => session.id))
    const hidden: SessionId[] = []
    const deleteLedger = new Set<SessionId>()
    const upserts: Array<{ id: SessionId; entry: ObservedPersistedSession; state: SyncRowState }> = []
    const work: SyncWorkItem[] = []
    for (const [id, entry] of listed) {
      const row = ledger.get(id)
      if (committed.get(id) === entry.revision) {
        if (row !== undefined) deleteLedger.add(id)
        continue
      }
      if (committed.has(id)) hidden.push(id)
      if (liveOwned.has(id)) {
        if (row === undefined || row.revision !== entry.revision || row.state !== 'live') {
          upserts.push({ id, entry, state: 'live' })
        }
        continue
      }
      if (row === undefined || row.revision !== entry.revision || row.state === 'live') {
        upserts.push({ id, entry, state: 'pending' })
      }
      if (row?.state === 'failed' && row.revision === entry.revision && row.attempts >= 2) {
        const delay = Math.min(300_000, 5_000 * 2 ** Math.min(row.attempts - 2, 6))
        const elapsed = Date.now() - row.observed_at
        if (elapsed >= 0 && elapsed < delay) continue
      }
      work.push({ id, revision: entry.revision, header: entry.header })
    }
    for (const id of committed.keys()) if (!listed.has(id)) hidden.push(id)
    for (const id of ledger.keys()) if (!listed.has(id)) deleteLedger.add(id)
    if (hidden.length > 0 || deleteLedger.size > 0 || upserts.length > 0) {
      this._transaction(() => {
        for (const id of hidden) this._deleteSession('persisted', id)
        for (const id of deleteLedger) db.prepare('DELETE FROM sync_sessions WHERE id = ?').run(id)
        for (const upsert of upserts) this._upsertSyncRow(upsert.id, upsert.entry, upsert.state)
      })
    }
    if (hidden.length > 0) this._globalGeneration += 1
    this._syncVerified = true
    this._syncCheckedAt = Date.now()
    this._syncListingFailed = false
    this._syncScanFailed = false
    return work
  }

  private _upsertSyncRow(id: SessionId, entry: ObservedPersistedSession, state: SyncRowState): void {
    this._requireDb().prepare(`
      INSERT INTO sync_sessions
        (id, version, created_at, cwd, parent_session, seeded, delegation_depth, agent_preset,
         revision, state, attempts, error, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        created_at = excluded.created_at,
        cwd = excluded.cwd,
        parent_session = excluded.parent_session,
        seeded = excluded.seeded,
        delegation_depth = excluded.delegation_depth,
        agent_preset = excluded.agent_preset,
        attempts = CASE WHEN revision <> excluded.revision THEN 0 ELSE attempts END,
        error = CASE WHEN revision <> excluded.revision THEN NULL ELSE error END,
        revision = excluded.revision,
        state = excluded.state,
        observed_at = excluded.observed_at
    `).run(
      id,
      entry.header.version,
      entry.header.createdAt,
      entry.header.cwd ?? null,
      entry.header.parentSession ?? null,
      entry.header.isSeeded ? 1 : 0,
      entry.header.delegationDepth ?? null,
      entry.header.agentPreset ?? null,
      entry.revision,
      state,
      Date.now(),
    )
  }

  private async _runSyncReads(
    persistence: SessionPersistence,
    work: readonly SyncWorkItem[],
    signal: AbortSignal,
  ): Promise<void> {
    if (work.length === 0) return
    const concurrency = Math.min(this.config.syncReadConcurrency, work.length)
    const batchSize = this.config.syncBatchSessions
    let next = 0
    let pending: Array<{ readonly target: SyncWorkItem; readonly prepared: SessionPublication }> = []
    let flushing: Promise<void> = Promise.resolve()
    const flush = (): Promise<void> => {
      if (pending.length === 0) return flushing
      const batch = pending
      pending = []
      flushing = flushing.then(async () => {
        await this._serialized(signal, () => {
          this._publishPreparedBatch(batch)
        })
        // Bound each event-loop hold so a large first index never blocks searches.
        await scheduler.yield()
      })
      return flushing
    }
    const readNext = async (): Promise<void> => {
      while (!this._syncCancelled(signal)) {
        const item = work[next]
        next += 1
        if (item === undefined) return
        const prepared = await this._prepareSyncSource(persistence, item, signal)
        if (prepared === undefined) continue
        pending.push({ target: item, prepared })
        if (pending.length >= batchSize) await flush()
      }
    }
    await Promise.all(Array.from({ length: concurrency }, readNext))
    await flush()
    await flushing
  }

  private async _prepareSyncSource(
    persistence: SessionPersistence,
    target: SyncWorkItem,
    signal: AbortSignal,
  ): Promise<SessionPublication | undefined> {
    try {
      const options = { signal }
      const before = await persistence.stat(target.id, options)
      if (this._syncCancelled(signal)) return undefined
      // Absent sources are resolved by the next complete listing, which owns deletion.
      if (before === undefined) return undefined
      if (before.revision !== target.revision) return undefined
      const log = await readColdSessionLog(persistence, target.id, signal)
      if (this._syncCancelled(signal)) return undefined
      const after = await persistence.stat(target.id, options)
      if (this._syncCancelled(signal)) return undefined
      // A generation that moved during the read is retried by the next scan
      // instead of publishing a mixed-cut prefix.
      if (after === undefined || after.revision !== before.revision) return undefined
      if (log.inheritedEventCount > log.storedEventCount) {
        await this._recordSourceFailure(target, signal, 'inherited prefix exceeds the stored log')
        return undefined
      }
      assertSessionHeadersCompatible(target.header, log.header)
      return prepareSessionPublication(log)
    } catch (error: unknown) {
      if (this._syncCancelled(signal)) return undefined
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') return undefined
      await this._recordSourceFailure(target, signal, errorMessage(error))
      return undefined
    }
  }

  private async _recordSourceFailure(
    target: SyncWorkItem,
    signal: AbortSignal,
    detail: string,
  ): Promise<void> {
    if (this._syncCancelled(signal)) return
    await this._serialized(signal, () => {
      const db = this._requireDb()
      const row = db.prepare('SELECT revision FROM sync_sessions WHERE id = ?').get(target.id) as {
        revision: string
      } | undefined
      if (row === undefined || row.revision !== target.revision) return
      db.prepare(`
        UPDATE sync_sessions
        SET state = 'failed', attempts = attempts + 1, error = ?, observed_at = ?
        WHERE id = ?
      `).run(detail, Date.now(), target.id)
    })
  }

  /**
   * Commit one batch of validated source generations atomically. Every entry is
   * rechecked against the pending generation it was read for; rows whose source
   * moved are skipped and retried by the next pass. One transaction and one
   * generation step cover the accepted entries, which keeps commit/fsync cost
   * off the per-session path.
   * @param batch - validated publications paired with the listed generation they came from.
   */
  private _publishPreparedBatch(
    batch: readonly { readonly target: SyncWorkItem; readonly prepared: SessionPublication }[],
  ): void {
    if (this._closed) throw indexClosed()
    if (this._persistenceBinding.identity !== this._syncBinding) return
    const db = this._requireDb()
    const lookup = db.prepare('SELECT revision FROM sync_sessions WHERE id = ?')
    const accepted = batch.filter(({ target }) => {
      const row = lookup.get(target.id) as { revision: string } | undefined
      return row !== undefined && row.revision === target.revision
    })
    if (accepted.length === 0) return
    let next = this._globalGeneration
    this._transaction(() => {
      next = this._mainGeneration() + 1
      for (const { target, prepared } of accepted) {
        this._deleteSession('persisted', target.id)
        this._replacePersistedSession(prepared, target.revision, next)
        db.prepare('DELETE FROM sync_sessions WHERE id = ?').run(target.id)
      }
      db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(next)
    })
    this._globalGeneration = next
    this._localGeneration = Math.max(this._localGeneration, next)
  }

  private _sessionSearchCoverage(request: NormalizedSessionRequest): SessionSearchCoverage {
    if (!this._syncVerified) return unverifiedCoverage()
    return this._coverageFrom(this._scopeCounts(request.sessionFilters, undefined))
  }

  private _eventSearchCoverage(sessionId: SessionId): SessionSearchCoverage {
    if (!this._syncVerified) return unverifiedCoverage()
    return this._coverageFrom(this._scopeCounts([], sessionId))
  }

  private _coverageFrom(counts: ScopedCoverageCounts): SessionSearchCoverage {
    const coverage: SessionSearchCoverage = {
      state: this._coverageState(counts),
      indexedSessions: counts.indexed,
      pendingSessions: counts.pending,
      failedSessions: counts.failed,
    }
    if (this._syncCheckedAt !== undefined) coverage.checkedAt = this._syncCheckedAt
    return coverage
  }

  private _coverageState(counts: ScopedCoverageCounts): SessionSearchCoverage['state'] {
    if (!this._syncVerified) return 'initializing'
    if (this._syncListingFailed || this._syncScanFailed || counts.failed > 0) return 'degraded'
    if (counts.pending > 0) return 'syncing'
    return 'ready'
  }

  /**
   * Count indexed, pending, and failed sessions matching the request's session
   * predicates. The same compiled predicates scope every count, so a caller
   * never observes sessions outside its authorized filter.
   * @param filters - validated ANDed logical-session clauses.
   * @param sessionId - optional single target, used by event searches.
   * @returns scoped counts for the three coverage dimensions.
   */
  private _scopeCounts(
    filters: readonly SessionResultFilter[],
    sessionId: SessionId | undefined,
  ): ScopedCoverageCounts {
    const sessionWhere = buildSessionWhere(filters)
    const clauses = [sessionWhere.sql]
    const params = [...sessionWhere.params]
    if (sessionId !== undefined) {
      clauses.push('session_id = ?')
      params.push(sessionId)
    }
    const where = clauses.filter(Boolean).join(' AND ')
    const rows = this._requireDb().prepare(`
      WITH scoped AS (
        SELECT
          'indexed' AS kind,
          ps.id AS session_id,
          ps.created_at AS created_at,
          ps.cwd AS cwd,
          ps.parent_session AS parent_session,
          0 AS live,
          1 AS persisted
        FROM persisted_sessions AS ps
        WHERE NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = ps.id)
        UNION ALL
        SELECT
          'indexed' AS kind,
          ls.id AS session_id,
          ls.created_at AS created_at,
          ls.cwd AS cwd,
          ls.parent_session AS parent_session,
          1 AS live,
          ls.persisted AS persisted
        FROM temp.live_sessions AS ls
        UNION ALL
        SELECT
          CASE WHEN ss.state = 'live' THEN 'pending' ELSE ss.state END AS kind,
          ss.id AS session_id,
          ss.created_at AS created_at,
          ss.cwd AS cwd,
          ss.parent_session AS parent_session,
          0 AS live,
          1 AS persisted
        FROM sync_sessions AS ss
        WHERE ss.state IN ('pending', 'failed', 'live')
          AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = ss.id)
      )
      SELECT kind, COUNT(*) AS sessions FROM scoped
      ${where.length === 0 ? '' : `WHERE ${where}`}
      GROUP BY kind
    `).all(...params)
    const counts: ScopedCoverageCounts = { indexed: 0, pending: 0, failed: 0 }
    for (const row of rows) {
      if (typeof row.kind !== 'string' || typeof row.sessions !== 'number') {
        throw new SessionQueryError(
          'session-search coverage query returned an unexpected row',
          'SESSION_QUERY_INDEX_FAILED',
        )
      }
      if (row.kind === 'indexed') counts.indexed = row.sessions
      else if (row.kind === 'pending') counts.pending = row.sessions
      else if (row.kind === 'failed') counts.failed = row.sessions
    }
    return counts
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
    const liveById = liveIndexRows(db)
    const liveRows = [...liveById.values()]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const observation = await this._observeStable(persistedById, signal)
    assertNotAborted(signal)
    const persistentChanges = observation.persistenceBinding.service === undefined
      ? []
      : [...observation.persisted.values()].filter(entry => entry.loaded !== undefined)
    const persistentDeletes = observation.persistenceBinding.service === undefined
      ? []
      : persistedRows.filter(row => !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.persisted.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== observation.persistenceBinding.identity
    const hasWrites = persistentChanges.length > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.persisted.has(entry.header.id),
      }
    })

    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        for (const entry of persistentChanges) {
          /* v8 ignore next -- observation loads every entry whose revision differs */
          if (entry.loaded === undefined) throw new Error(`missing loaded revision for session "${entry.header.id}"`)
          this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration)
        }
        if (persistentChanges.length > 0 || persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
        db.exec('COMMIT')
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = observation.persistenceBinding.identity
    return observation.persistenceBinding
  }

  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
  ): Promise<Observation> {
    for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal)
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const initiallyLive = new Map(this.ctx.sessions.list().map(session => [session.id, session]))
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      if (persistence !== undefined) {
        try {
          const canReuseIndexed = this._lastPersistenceIdentity === undefined
            || this._lastPersistenceIdentity === persistenceBinding.identity
          const listOptions = signal === undefined ? undefined : { signal }
          const before = await persistence.list(listOptions)
          assertNotAborted(signal)
          persisted = materializePersistenceSnapshots(before)
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue
            // Skip work already shadowed by a live owner. The cold read is
            // non-mutating (interrupted turns are balanced in memory only), so
            // an owner attaching after this check cannot cause side effects;
            // the live-membership retry below makes the returned observation
            // live-preferred.
            if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined) continue
            assertNotAborted(signal)
            const loaded = await readColdSessionLog(persistence, entry.header.id, signal)
            assertNotAborted(signal)
            assertSessionHeadersCompatible(entry.header, loaded.header)
            entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events)
          }
          assertNotAborted(signal)
          const afterSnapshots = await persistence.list(listOptions)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          if (!samePersistenceSnapshots(persisted, after, (id) => {
            const owner = initiallyLive.get(id)
            return owner !== undefined && this.ctx.sessions.get(id) === owner
          })) continue
          if (this._persistenceBinding !== persistenceBinding) continue
        } catch (error: unknown) {
          if (isAbort(error) || signal?.aborted) {
            throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', {
              cause: error,
            })
          }
          if (this._persistenceBinding !== persistenceBinding) continue
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const liveOwners = new Map(this.ctx.sessions.list().map(session => [session.id, session]))
      if (!sameSessionOwners(initiallyLive, liveOwners)) continue
      if (this._persistenceBinding !== persistenceBinding) continue
      const live = new Map<SessionId, ObservedSession>()
      for (const session of liveOwners.values()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      return { persistenceBinding, persisted, live }
    }
    throw new SessionQueryError(
      'session-search persistence observation did not stabilize after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED',
    )
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: SessionPublication,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    this._deleteSession('persisted', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      revision,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        segmentHan(text),
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _replaceLiveSession(entry: ObservedSession, generation: number, persisted: boolean): void {
    this._deleteSession('live', entry.header.id)
    this._upsertLiveHeader(entry.header, entry.inheritedEventCount, entry.fingerprint, Number(persisted), generation)
    this._publishLiveDocuments(entry.documents, undefined)
  }

  private _upsertLiveHeader(
    header: SessionHeader, inherited: SessionLogOffset, fingerprint: string, persisted: number, generation: number,
  ): void {
    this._requireDb().prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        fingerprint = excluded.fingerprint, persisted = excluded.persisted, generation = excluded.generation
    `).run(...headerBindings(header, inherited), fingerprint, persisted, generation)
  }

  private _publishLiveDocuments(
    documents: readonly SessionEventSearchDocument[],
    previous: ReadonlyMap<SessionSeq, LiveIndexedDocument> | undefined,
  ): Map<SessionSeq, LiveIndexedDocument> {
    const db = this._requireDb()
    const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const next = new Map<SessionSeq, LiveIndexedDocument>()
    // Within an append-only Session instance an existing event can change surface, but its text is immutable.
    const update = previous === undefined ? undefined : db.prepare('UPDATE temp.live_docs SET surface = ? WHERE rowid = ?')
    for (const document of documents) {
      const row = previous?.get(document.seq)
      if (row !== undefined) {
        if (row.surface !== document.surface) update?.run(document.surface, row.rowid)
        next.set(document.seq, { rowid: row.rowid, surface: document.surface })
        continue
      }
      const text = sanitizeFtsText(document.text)
      const { lastInsertRowid } = insert.run(
        segmentHan(text),
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
      next.set(document.seq, { rowid: lastInsertRowid, surface: document.surface })
    }
    return next
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
    limit = request.limit,
  ): SearchRow[] {
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const selected = selectedDocumentsSql(where)
    const filterParams = [...sessionWhere.params, ...eventWhere.params]
    const bindings = [
      ...candidateBindings(request.query, this._persistedContentVisible(persistenceBinding), filterParams),
      limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql},
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM matched
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
    limit = request.limit,
  ): SearchRow[] {
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const selected = selectedDocumentsSql(where)
    const filterParams = [request.sessionId, ...eventWhere.params]
    const bindings = [
      ...candidateBindings(request.query, this._persistedContentVisible(persistenceBinding), filterParams),
      limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (this._persistedContentVisible(persistenceBinding)) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
      // A listed source whose generation is still pending is not a missing
      // session: answer with its header and an empty, coverage-marked page.
      if (this.config.syncMode === 'background') {
        const ledger = db.prepare(
          `SELECT
            id, version, created_at, cwd, parent_session, seeded, delegation_depth, agent_preset, revision
          FROM sync_sessions
          WHERE id = ?`,
        ).get(sessionId) as SyncHeaderRow | undefined
        if (ledger !== undefined) {
          return {
            header: syncRowHeader(ledger),
            generation: `pending:${this._persistenceEpoch}:${ledger.revision}`,
          }
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: SessionSeq(row.seq),
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

/**
 * The header columns both session upserts bind, in the order their INSERT
 * lists them. The two statements differ only in what they append after these.
 * @param header - the session header being written.
 * @returns one bound value per header column.
 */
function headerBindings(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function selectedDocumentsSql(filterSql: string): { sql: string } {
  // Keep the correctness repair only: filter and rank the complete match set.
  // Do not impose a lossy shortlist or force a materialized highlight stage.
  return {
    sql: `WITH source_candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), candidates AS (
      SELECT * FROM source_candidates ${filterSql.length === 0 ? '' : `WHERE ${filterSql}`}
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`,
  }
}

function candidateBindings(
  query: string,
  persistenceVisible: boolean,
  filterParams: readonly (string | number)[],
): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  const tail = [FTS_HIGHLIGHT_START, Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8')]
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    ...filterParams,
    ...tail,
  ]
}

function observeLive(session: Session): ObservedSession {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return observeSession(session.header, session.inheritedEventCount, session.snapshotEvents())
}

function observeSession(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, inheritedEventCount, events: detachedEvents }))
      .digest('base64url'),
  }
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function samePersistenceSnapshots(
  before: ReadonlyMap<SessionId, ObservedPersistedSession>,
  after: ReadonlyMap<SessionId, ObservedPersistedSession>,
  revisionShadowed: (id: SessionId) => boolean,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (
      second === undefined
      || (first.revision !== second.revision && !revisionShadowed(id))
      || !sameHeader(first.header, second.header)
    ) return false
  }
  return true
}

function sameSessionOwners(
  before: ReadonlyMap<SessionId, Session>,
  after: ReadonlyMap<SessionId, Session>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, owner] of before) {
    if (after.get(id) !== owner) return false
  }
  return true
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.isSeeded === b.isSeeded
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

/**
 * Read the connection-local live rows by session id.
 * @param db - owned derived-index connection.
 * @returns current TEMP live rows keyed by session id.
 */
function liveIndexRows(db: DatabaseSync): Map<SessionId, IndexedLiveRow> {
  const rows = db.prepare(
    'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
  ).all() as unknown as IndexedLiveRow[]
  return new Map(rows.map(row => [row.id as SessionId, row]))
}

/**
 * Project one balanced cold log into the immutable publication a background
 * commit writes. No source, database, or service access happens here, so the
 * same input produces the same rows on any thread.
 * @param log - cold log whose stored revision held before and after the read.
 * @returns header, exact inherited cut, and semantic documents to publish.
 */
function prepareSessionPublication(log: ColdSessionLog): SessionPublication {
  return {
    header: log.header,
    inheritedEventCount: log.inheritedEventCount,
    documents: buildSessionEventSearchDocuments(log.header.id, log.events),
  }
}

/** Coverage reported until the index is verified against the current source. */
function unverifiedCoverage(): SessionSearchCoverage {
  return { state: 'initializing' }
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function syncRowHeader(row: SyncHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seeded === 1,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function parseCursor(cursor: SessionSearchCursorValue): CursorPayloadValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor(new Error('cursor payload must be a JSON object'))
  }
  return parsed
}

function snapshotContinuation(
  payload: CursorPayloadValue,
  instance: string,
  scope: SnapshotCursorPayload['scope'],
  fingerprint: string,
): SnapshotContinuation | undefined {
  if (payload.version !== 2) return undefined
  const { snapshot, offset } = payload
  if (
    payload.instance !== instance
    || payload.scope !== scope
    || payload.fingerprint !== fingerprint
    || typeof snapshot !== 'string'
    || typeof offset !== 'number'
    || !Number.isSafeInteger(offset)
    || offset < 0
  ) {
    throw invalidCursor(new Error('snapshot cursor does not belong to this normalized request'))
  }
  return { snapshot, offset }
}

function decodeCursor(
  payload: CursorPayloadValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  if (
    payload.version !== 1
    || payload.instance !== instance
    || payload.scope !== scope
    || payload.fingerprint !== fingerprint
    || !Number.isSafeInteger(payload.offset)
    || payload.offset === undefined
    || payload.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (payload.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return payload.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function staleSnapshot(): SessionQueryError {
  return new SessionQueryError(
    'session-search snapshot is no longer available',
    'SESSION_QUERY_STALE_CURSOR',
  )
}

/**
 * Take one page from a captured ranking and continue it while hits remain.
 * @param snapshot - captured hits in ranking order.
 * @param instance - owning engine identity bound into the next cursor.
 * @param scope - search kind bound into the next cursor.
 * @param offset - first captured hit of this page.
 * @param limit - maximum hits in this page.
 * @returns the page, with a snapshot cursor while more hits remain.
 */
function snapshotPage<Row, Meta>(
  snapshot: SearchSnapshot<Row, Meta>,
  instance: string,
  scope: SnapshotCursorPayload['scope'],
  offset: number,
  limit: number,
): SessionSearchPage<Row> {
  const items = snapshot.rows.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  if (nextOffset >= snapshot.rows.length) return { items }
  return {
    items,
    nextCursor: SessionSearchCursor(Buffer.from(JSON.stringify({
      version: 2,
      instance,
      scope,
      fingerprint: snapshot.fingerprint,
      snapshot: snapshot.id,
      offset: nextOffset,
    } satisfies SnapshotCursorPayload), 'utf8').toString('base64url')),
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
    syncMode: config.syncMode ?? 'on-search',
    syncIntervalMs: config.syncIntervalMs ?? SESSION_QUERY_SQLITE_DEFAULT_SYNC_INTERVAL_MS,
    syncReadConcurrency: config.syncReadConcurrency ?? SESSION_QUERY_SQLITE_DEFAULT_SYNC_READ_CONCURRENCY,
    syncBatchSessions: config.syncBatchSessions ?? SESSION_QUERY_SQLITE_DEFAULT_SYNC_BATCH_SESSIONS,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedReadConcurrency)
    || resolved.persistedReadConcurrency < 1
  ) {
    throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.preparedSessionCacheSize)
    || resolved.preparedSessionCacheSize < 1
  ) {
    throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  const syncModes: readonly string[] = ['on-search', 'background']
  if (!syncModes.includes(resolved.syncMode)) throw invalidConfig('syncMode is not supported')
  if (
    !Number.isSafeInteger(resolved.syncIntervalMs)
    || resolved.syncIntervalMs < 1
    || resolved.syncIntervalMs > MAX_SYNC_INTERVAL_MS
  ) {
    throw invalidConfig(`syncIntervalMs must be an integer between 1 and ${MAX_SYNC_INTERVAL_MS}`)
  }
  if (
    !Number.isSafeInteger(resolved.syncReadConcurrency)
    || resolved.syncReadConcurrency < 1
  ) {
    throw invalidConfig('syncReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.syncBatchSessions)
    || resolved.syncBatchSessions < 1
    || resolved.syncBatchSessions > 10_000
  ) {
    throw invalidConfig('syncBatchSessions must be an integer between 1 and 10000')
  }
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine
