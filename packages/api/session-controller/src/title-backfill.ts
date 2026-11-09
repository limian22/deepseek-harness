/**
 * Bounded background recovery of cold Session titles into the persisted
 * projection cache.
 *
 * The queue is intentionally boring: one stored read at a time, a macrotask
 * between items, a fresh batch of up to 64 picks from a single queue that
 * keeps running until empty, per-session dedupe and failure backoff, and one
 * lifetime abort signal. Every checkpoint is built from the stored prefix
 * only; synthetic interrupted-turn closers never reach the cache.
 *
 * @module @deepseek-ai/dsh-api-session-controller/src/title-backfill
 */

import { scheduler } from 'node:timers/promises'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { ProjectionKeySelection, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { SessionRecord, StableColdLog } from '@deepseek-ai/dsh-session-query'
import type { SessionSummary } from './types.ts'

/** The persisted-cache faces the backfill consumes. */
export interface ColdTitleCheckpointStore {
  /** Zero-I/O listing read; a present `title` key means the row is already covered. */
  cachedSnapshot(meta: SessionHeader, keys?: ProjectionKeySelection): ProjectionSnapshot | undefined
  /** Narrow predecessor title read; a present title is already covered too. */
  cachedPredecessorTitle(meta: SessionHeader): ProjectionSnapshot | undefined
  /** Durably replace the record from a caller-proven stored prefix. */
  coldSnapshotDurable(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    durableThroughSeq: SessionSeqCursor,
    events: readonly SessionEvent[],
    options?: { readonly guard?: () => boolean | Promise<boolean> },
  ): Promise<ProjectionSnapshot | undefined>
}

/** Collaborators supplied by the Session Controller. */
export interface ColdTitleBackfillDeps {
  /** Read one stable stored prefix; `undefined` means no durable prefix is provable. */
  readonly read: (id: SessionId, signal: AbortSignal) => Promise<StableColdLog | undefined>
  readonly cache: ColdTitleCheckpointStore
  /** Whether the shipped title projection is registered and can be folded. */
  readonly titleReady: () => boolean
  /** Whether the id is currently attached to the Session store. */
  readonly isLive: (id: SessionId) => boolean
  /** Recheck removal/replacement/identity immediately before the durable put. */
  readonly verify: (log: StableColdLog, signal: AbortSignal) => boolean | Promise<boolean>
  /** Build the current list summary for one recovered record. */
  readonly summarize: (record: SessionRecord) => SessionSummary
  /** Publish one changed summary to list consumers. */
  readonly notify: (summary: SessionSummary) => void
  /** Optional diagnostic sink; no Session content or titles are included. */
  readonly onDebug?: (message: string) => void
}

/** Bounds and scheduling hooks for {@link ColdTitleBackfill}. */
export interface ColdTitleBackfillOptions {
  /** Candidates picked per batch; the run continues with another batch until empty. */
  readonly batchSize?: number
  /** In-process retry boundary after a failed read or refused write. */
  readonly failureBackoffMs?: number
  /** Poll interval while waiting for a late title projection registration. */
  readonly titleRetryMs?: number
  /** Longest wait for the title projection before leaving the queue for a later listing. */
  readonly titleWaitMs?: number
  readonly now?: () => number
  /** Deferred first work so the listing response leaves before history I/O starts. */
  readonly startDelay?: () => Promise<void>
  /** Event-loop yield after each candidate. */
  readonly yieldBetween?: () => Promise<void>
}

/**
 * One single-flight, bounded, cancellable title-recovery queue.
 */
export class ColdTitleBackfill {
  private readonly queue: SessionRecord[] = []
  /** Ids queued or currently being read; repeated schedule calls cannot duplicate work. */
  private readonly queued = new Set<SessionId>()
  /** Lifecycle identity of each successfully recovered or deliberately skipped id. */
  private readonly attempted = new Map<SessionId, string>()
  /** Ids that failed, with the earliest in-process retry time. */
  private readonly failedUntil = new Map<SessionId, number>()
  private readonly lifetime = new AbortController()
  private readonly batchSize: number
  private readonly failureBackoffMs: number
  private readonly titleRetryMs: number
  private readonly titleWaitMs: number
  private readonly now: () => number
  private readonly startDelay: () => Promise<void>
  private readonly yieldBetween: () => Promise<void>
  private running: Promise<void> | undefined
  private disposed = false

  /**
   * @param deps - stored read, cache write, guards, summary, and notification.
   * @param options - bounds and scheduling hooks (defaults are production-safe).
   */
  constructor(
    private readonly deps: ColdTitleBackfillDeps,
    options: ColdTitleBackfillOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 64
    this.failureBackoffMs = options.failureBackoffMs ?? 300_000
    this.titleRetryMs = options.titleRetryMs ?? 25
    this.titleWaitMs = options.titleWaitMs ?? 2_000
    this.now = options.now ?? Date.now
    this.startDelay = options.startDelay ?? (async () => { await scheduler.wait(0) })
    this.yieldBetween = options.yieldBetween ?? (async () => { await scheduler.yield() })
  }

  /** The queue's lifetime signal; canceled by {@link dispose}. */
  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  /**
   * Add current, non-live, uncached list rows to the single-flight queue.
   * Safe to call while a run is in progress; duplicates are ignored.
   * @param records - cold list rows from one listing.
   */
  schedule(records: readonly SessionRecord[]): void {
    if (this.disposed) return
    const now = this.now()
    for (const record of records) {
      if (record.header.cwd === undefined || record.formatStatus !== 'current') continue
      const id = record.header.id
      if (this.queued.has(id) || this.attempted.get(id) === lifecycleKey(record.header)) continue
      if ((this.failedUntil.get(id) ?? 0) > now) continue
      this.queued.add(id)
      this.queue.push(record)
    }
    this.start()
  }

  /**
   * Wait for the current queue to drain (used by tests and orderly shutdown).
   * @returns after the active run, if any, settles.
   */
  async drain(): Promise<void> {
    await this.running
  }

  /** Cancel pending and in-flight reads; a later read result is ignored. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new Error('cold title backfill was disposed'))
  }

  /** Whether the queue lifetime is finished. */
  private canceled(): boolean {
    return this.disposed
  }

  /** Start the one allowed run when work exists and no run is active. */
  private start(): void {
    // A run drains until the queue is empty; every remaining enqueue happens
    // while the loop can still observe it. When this run settles, the next
    // schedule sees `running === undefined` and starts a fresh one.
    if (this.running !== undefined || this.queue.length === 0) return
    this.running = this.run().finally(() => {
      this.running = undefined
      // A schedule can land after `run` resolves but before this finalizer:
      // it sees `running` set and only enqueues. Restart here, but never spin
      // while the title projection is still missing; that queue waits for the
      // next listing.
      if (!this.disposed && this.queue.length > 0 && this.deps.titleReady()) this.start()
    })
  }

  /** Process batches until the queue is empty or the lifetime is canceled. */
  private async run(): Promise<void> {
    await this.startDelay()
    if (!(await this.waitForTitle())) return
    while (!this.canceled()) {
      const batch = this.queue.splice(0, this.batchSize)
      if (batch.length === 0) return
      for (const record of batch) {
        if (this.canceled()) return
        await this.process(record)
        await this.yieldBetween()
      }
    }
  }

  /**
   * Wait for a late title projection registration before folding anything.
   * A missing unit means a fold would persist a record without a title row and
   * then mark the lifecycle attempted; the bounded wait lets a host that mounts
   * the title service after its first listing recover without another pull.
   * @returns whether the title projection is ready and the lifetime is alive.
   */
  private async waitForTitle(): Promise<boolean> {
    if (this.deps.titleReady()) return true
    const deadline = this.now() + this.titleWaitMs
    while (!this.canceled() && !this.deps.titleReady()) {
      if (this.now() >= deadline) return false
      await scheduler.wait(this.titleRetryMs)
    }
    return !this.canceled()
  }

  /** Recover one candidate, containing every failure to that candidate. */
  private async process(record: SessionRecord): Promise<void> {
    const id = record.header.id
    const signal = this.signal
    try {
      // The run loop already checked the lifetime synchronously before this
      // call; no await exists between that check and here.
      // Only a visible cached title is authoritative coverage. A `title: null`
      // row can be a stale creation-time cut that predates the real title, so
      // it must not block a recovery read; the in-process attempted set keeps
      // a genuinely untitled log from being reread until the next Host start.
      if (isVisibleTitle(this.deps.cache.cachedSnapshot(record.header, ['title'])?.values.title)
        || isVisibleTitle(this.deps.cache.cachedPredecessorTitle(record.header)?.values.title)) {
        this.markAttempted(record.header)
        return
      }
      if (this.deps.isLive(id)) return
      const log = await this.deps.read(id, signal)
      if (this.canceled()) return
      if (log === undefined || log.header.id !== id) {
        this.markFailed(id)
        return
      }
      // A live attach during the read already owns the cache write path; leave
      // the id unmarked so a later cold listing can retry if it detaches.
      if (this.deps.isLive(id)) return
      // The title unit can disappear while the read awaits; folding now would
      // persist a record without its title row.
      if (!this.deps.titleReady()) return
      if (log.inheritedEventCount > log.storedEventCount) {
        this.markFailed(id)
        return
      }
      const events = log.events.slice(0, log.storedEventCount)
      const durableThroughSeq = events.at(-1)?.seq ?? -1
      const written = await this.deps.cache.coldSnapshotDurable(
        log.header,
        log.inheritedEventCount,
        durableThroughSeq,
        events,
        { guard: () => this.verify(log, signal) },
      )
      if (written === undefined) {
        this.markFailed(id)
        return
      }
      // Re-prove the lifecycle after the put's I/O. A removal, recreation, or
      // migration during the put must not attach the old title to the new
      // lifecycle. No failure marker here: an id-keyed backoff would suppress
      // the new lifecycle for minutes, so the next listing may retry at once.
      if (!(await this.verify(log, signal))) return
      // The verify itself awaited: recheck the two facts a cold addition could
      // publish stale (`agentAvailable:false`/`running:false`) or that make the
      // recovered record irrelevant. From here to notify is synchronous.
      if (this.canceled()) return
      if (this.deps.isLive(id)) return
      // The awaited put succeeded, but a concurrent record replacement or
      // domain removal could already have erased it. Only mark the lifecycle
      // attempted while the cache still covers it.
      if (this.deps.cache.cachedSnapshot(log.header) === undefined) {
        this.markFailed(id)
        return
      }
      this.markAttempted(log.header)
      const summary = this.deps.summarize({
        header: log.header,
        live: false,
        persisted: true,
        formatStatus: 'current',
      })
      const title = (summary.projections?.values as { title?: unknown } | undefined)?.title
      if (isVisibleTitle(title)) this.deps.notify(summary)
    } catch (error: unknown) {
      if (this.canceled()) return
      this.markFailed(id)
      this.deps.onDebug?.(
        `cold title backfill skipped "${id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      this.queued.delete(id)
    }
  }

  /** Recheck liveness and the caller's identity/revision guard before the put. */
  private async verify(log: StableColdLog, signal: AbortSignal): Promise<boolean> {
    if (this.canceled()) return false
    if (this.deps.isLive(log.header.id)) return false
    return await this.deps.verify(log, signal)
  }

  /** Record one covered lifecycle for this Host lifetime. */
  private markAttempted(header: SessionHeader): void {
    this.attempted.set(header.id, lifecycleKey(header))
    this.failedUntil.delete(header.id)
  }

  /** Record a retry boundary for a candidate that could not be recovered now. */
  private markFailed(id: SessionId): void {
    this.failedUntil.set(id, this.now() + this.failureBackoffMs)
  }
}

/** Whether a projection value is a title the listing can actually display. */
function isVisibleTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The lifecycle identity the cache itself binds a record to. A removed and
 * recreated Session reuses its id but not this key, so an in-process attempted
 * marker never suppresses the new lifecycle.
 */
function lifecycleKey(header: SessionHeader): string {
  return [
    header.version,
    header.createdAt,
    header.cwd ?? '',
    header.isSeeded ? 'seeded' : 'unseeded',
  ].join('|')
}
