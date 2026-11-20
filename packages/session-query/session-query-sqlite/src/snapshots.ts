/**
 * Bounded captured result sets that keep multi-page search stable.
 *
 * A page cursor normally binds to the generation of the corpus it was minted
 * from, so any concurrent write invalidates the rest of that pagination. A
 * snapshot instead keeps the captured hits in memory, which lets every later
 * page read the same ranking without re-observing the sources.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/snapshots
 */

import { randomUUID } from 'node:crypto'

/** How long one captured result set stays continuable. */
export const SESSION_QUERY_SNAPSHOT_TTL_MS = 120_000

/** Most captured result sets one store retains. */
export const SESSION_QUERY_SNAPSHOT_MAX_ENTRIES = 8

/** Most hits one captured result set keeps. */
export const SESSION_QUERY_SNAPSHOT_MAX_ROWS = 500

/** Most JSON bytes one store's captured hits may hold. */
export const SESSION_QUERY_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

/** Retention limits for one snapshot store. */
export interface SnapshotLimits {
  /** Age after which a captured result set is no longer continuable. */
  ttlMs: number
  /** Most captured result sets retained before the oldest is evicted. */
  maxEntries: number
  /** Most hits retained from one search. */
  maxRows: number
  /** Most JSON bytes of captured hits retained across all entries. */
  maxBytes: number
}

/** One immutable captured result set. */
export interface SearchSnapshot<Row, Meta> {
  /** Opaque identifier carried by continuation cursors. */
  readonly id: string
  /** Normalized request identity this capture belongs to. */
  readonly fingerprint: string
  /** Captured hits in their original ranking order. */
  readonly rows: readonly Row[]
  /** Scope-owned payload captured beside the hits. */
  readonly meta: Meta
}

interface StoredSnapshot<Row, Meta> {
  readonly snapshot: SearchSnapshot<Row, Meta>
  readonly bytes: number
  readonly storedAt: number
}

const DEFAULT_LIMITS: SnapshotLimits = {
  ttlMs: SESSION_QUERY_SNAPSHOT_TTL_MS,
  maxEntries: SESSION_QUERY_SNAPSHOT_MAX_ENTRIES,
  maxRows: SESSION_QUERY_SNAPSHOT_MAX_ROWS,
  maxBytes: SESSION_QUERY_SNAPSHOT_MAX_BYTES,
}

/**
 * Process-local store of captured hits with bounded age and memory.
 *
 * Entries are evicted oldest-stored-first. `take` marks its entry as the most
 * recently used one so an actively paged search survives a burst of new
 * searches.
 */
export class SnapshotStore<Row, Meta> {
  private readonly entries = new Map<string, StoredSnapshot<Row, Meta>>()
  private bytes = 0
  private readonly limits: SnapshotLimits

  /** @param limits - retention limits; defaults to the package constants. */
  constructor(limits: SnapshotLimits = DEFAULT_LIMITS) {
    this.limits = limits
  }

  /**
   * Capture one result set, evicting whatever no longer fits.
   * @param fingerprint - normalized request identity the capture belongs to.
   * @param rows - hits in ranking order; at most `maxRows` are kept.
   * @param meta - scope-owned payload returned with the capture.
   * @returns the stored capture, including its continuation identifier.
   */
  store(fingerprint: string, rows: readonly Row[], meta: Meta): SearchSnapshot<Row, Meta> {
    const storedAt = Date.now()
    this.purge(storedAt)
    const kept = rows.slice(0, this.limits.maxRows)
    const bytes = Buffer.byteLength(JSON.stringify(kept), 'utf8')
    while (this.entries.size > 0
      && (this.entries.size >= this.limits.maxEntries || this.bytes + bytes > this.limits.maxBytes)) {
      const oldest = this.entries.entries().next()
      /* v8 ignore next 2 -- the loop condition guarantees one remaining entry */
      if (oldest.done === true) break
      this.remove(oldest.value[0], oldest.value[1])
    }
    const snapshot: SearchSnapshot<Row, Meta> = { id: randomUUID(), fingerprint, rows: kept, meta }
    this.entries.set(snapshot.id, { snapshot, bytes, storedAt })
    this.bytes += bytes
    return snapshot
  }

  /**
   * Return a capture and mark it most recently used.
   * @param id - identifier carried by a continuation cursor.
   * @returns the capture, or `undefined` when it expired or was evicted.
   */
  take(id: string): SearchSnapshot<Row, Meta> | undefined {
    this.purge(Date.now())
    const stored = this.entries.get(id)
    if (stored === undefined) return undefined
    this.entries.delete(id)
    this.entries.set(id, stored)
    return stored.snapshot
  }

  /** Drop every capture; used when the owning service closes. */
  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  private purge(now: number): void {
    for (const [id, stored] of this.entries) {
      if (now - stored.storedAt < this.limits.ttlMs) continue
      this.remove(id, stored)
    }
  }

  private remove(id: string, stored: StoredSnapshot<Row, Meta>): void {
    this.entries.delete(id)
    this.bytes -= stored.bytes
  }
}
