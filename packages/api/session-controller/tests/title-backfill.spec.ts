/**
 * Bounded cold-title backfill queue: one item at a time, a macrotask between
 * durable reads, batch continuation without another list request, request
 * dedupe, failure backoff, cancellation, and the stored-prefix watermark
 * handed to the cache.
 */

import { describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionRecord, StableColdLog } from '@deepseek-ai/dsh-session-query'
import type { SessionSummary } from '../src/types.ts'
import { ColdTitleBackfill } from '../src/title-backfill.ts'
import type { ColdTitleBackfillDeps, ColdTitleBackfillOptions } from '../src/title-backfill.ts'

const sid = (value: string): SessionIdType => SessionId(value)

function record(
  id: string,
  options: {
    createdAt?: number
    cwd?: string | null
    formatStatus?: 'current' | 'migration-required' | null
    isSeeded?: boolean
  } = {},
): SessionRecord {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: options.createdAt ?? 0,
    isSeeded: options.isSeeded ?? false,
    ...options.cwd === undefined
      ? { cwd: '/workspace' }
      : options.cwd === null ? {} : { cwd: options.cwd },
  }
  const formatStatus = options.formatStatus === undefined ? 'current' : options.formatStatus
  return {
    header,
    live: false,
    persisted: true,
    ...formatStatus === null ? {} : { formatStatus },
  }
}

/** The lifecycle fields the cache binds a checkpoint record to. */
function identityOf(header: SessionHeader): string {
  return `${String(header.createdAt)}|${header.cwd ?? ''}|${header.isSeeded ? 'seeded' : 'unseeded'}`
}

/** A thrown non-Error, to exercise the diagnostic fallback. */
class NonErrorFailure {
  toString(): string {
    return 'plain failure'
  }
}

function logFor(target: SessionRecord, storedEventCount = 1): StableColdLog {
  const events: SessionEvent[] = Array.from({ length: storedEventCount }, (_, seq) => ({
    type: 'turn/start',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn: 1 },
  })) as SessionEvent[]
  return {
    eventState: 'detached',
    header: target.header,
    inheritedEventCount: SessionLogOffset(0),
    events,
    storedEventCount,
    revision: SessionPersistenceRevision(`revision:${target.header.id}`),
  }
}

function summaryFor(target: SessionRecord, title: string | null = 'Recovered title'): SessionSummary {
  return {
    agentAvailable: false,
    sessionId: target.header.id,
    updatedAt: target.header.createdAt,
    running: false,
    blank: false,
    ...title === null ? {} : {
      projections: { kind: 'cached' as const, asOfSeq: SessionSeq(0), values: { title } },
    },
  }
}

interface HarnessOptions {
  readonly records: readonly SessionRecord[]
  readonly read?: ColdTitleBackfillDeps['read']
  readonly cachedSnapshot?: ColdTitleBackfillDeps['cache']['cachedSnapshot']
  readonly cachedPredecessorTitle?: ColdTitleBackfillDeps['cache']['cachedPredecessorTitle']
  readonly coldSnapshotDurable?: ColdTitleBackfillDeps['cache']['coldSnapshotDurable']
  readonly titleReady?: ColdTitleBackfillDeps['titleReady']
  readonly isLive?: ColdTitleBackfillDeps['isLive']
  readonly summarize?: ColdTitleBackfillDeps['summarize']
  readonly verify?: ColdTitleBackfillDeps['verify']
  readonly onDebug?: ColdTitleBackfillDeps['onDebug']
  readonly options?: ColdTitleBackfillOptions
}

function harness(options: HarnessOptions) {
  const byId = new Map(options.records.map(target => [target.header.id, target]))
  const read = vi.fn(options.read ?? (async (id: SessionIdType) => {
    const target = byId.get(id)
    return target === undefined ? undefined : logFor(target)
  }))
  const written = new Set<string>()
  const cacheKey = (meta: SessionHeader): string => `${meta.id}|${identityOf(meta)}`
  const defaultDurable: ColdTitleBackfillDeps['cache']['coldSnapshotDurable'] = async (meta) => {
    written.add(cacheKey(meta))
    return { asOfSeq: SessionSeq(0), values: {} }
  }
  const durable = vi.fn<ColdTitleBackfillDeps['cache']['coldSnapshotDurable']>(
    options.coldSnapshotDurable ?? defaultDurable,
  )
  const cache = {
    cachedSnapshot: vi.fn(options.cachedSnapshot ?? ((meta: SessionHeader) => written.has(cacheKey(meta))
      ? { asOfSeq: SessionSeq(0), values: { title: 'Recovered title' } }
      : undefined)),
    cachedPredecessorTitle: vi.fn(options.cachedPredecessorTitle ?? (() => undefined)),
    coldSnapshotDurable: durable,
  } satisfies ColdTitleBackfillDeps['cache']
  const notify = vi.fn()
  const backfill = new ColdTitleBackfill({
    read,
    cache,
    titleReady: options.titleReady ?? (() => true),
    isLive: options.isLive ?? (() => false),
    verify: options.verify ?? (() => true),
    summarize: options.summarize ?? (target => summaryFor(target)),
    notify,
    ...options.onDebug === undefined ? {} : { onDebug: options.onDebug },
  }, {
    batchSize: 64,
    failureBackoffMs: 500,
    startDelay: async () => {},
    yieldBetween: async () => {},
    ...options.options,
  })
  return { backfill, read, durable, cache, notify }
}

describe('ColdTitleBackfill', () => {
  it('continues across 64-item batches until every queued session is done', async () => {
    const records = Array.from({ length: 70 }, (_, index) => record(`session-${String(index)}`))
    const yields = vi.fn(async () => {})
    const h = harness({ records, options: { yieldBetween: yields } })

    h.backfill.schedule(records)
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(70)
    expect(h.durable).toHaveBeenCalledTimes(70)
    expect(h.notify).toHaveBeenCalledTimes(70)
    expect(yields).toHaveBeenCalledTimes(70)
  })

  it('hands the cache exactly the stored prefix and its last seq', async () => {
    const target = record('stored-prefix')
    const base = logFor(target, 2)
    const read = vi.fn(async (): Promise<StableColdLog> => ({
      ...base,
      storedEventCount: 2,
      events: [
        ...base.events,
        { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }))
    const h = harness({ records: [target], read })

    h.backfill.schedule([target])
    await h.backfill.drain()

    const call = h.durable.mock.calls[0] as unknown as [SessionHeader, unknown, number, readonly SessionEvent[]]
    expect(call[0]).toBe(target.header)
    expect(call[2]).toBe(1)
    expect(call[3]).toHaveLength(2)
    expect(call[3].map(event => event.seq)).toEqual([0, 1])
  })

  it('deduplicates repeated requests while a read is in flight', async () => {
    const records = [record('a'), record('b')]
    const gate = Promise.withResolvers<undefined>()
    const read = vi.fn(async (id: SessionIdType) => {
      await gate.promise
      const target = records.find(candidate => candidate.header.id === id)
      if (target === undefined) throw new Error('missing record')
      return logFor(target)
    })
    const h = harness({ records, read })

    h.backfill.schedule(records)
    await vi.waitFor(() => { expect(h.read).toHaveBeenCalledTimes(1) })
    h.backfill.schedule(records)
    gate.resolve(undefined)
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(2)
  })

  it('skips cached, live, non-current, and cwd-less candidates without reading', async () => {
    const cached = record('cached')
    const live = record('live')
    const migrated = record('migrated', { formatStatus: 'migration-required' })
    const pending = record('pending', { formatStatus: null })
    const noCwd = record('no-cwd', { cwd: null })
    const h = harness({
      records: [cached, live, migrated, pending, noCwd],
      cachedSnapshot: header => header.id === cached.header.id
        ? { asOfSeq: SessionSeq(0), values: { title: 'Already cached' } }
        : undefined,
      isLive: id => id === live.header.id,
    })

    h.backfill.schedule([cached, live, migrated, pending, noCwd])
    await h.backfill.drain()

    expect(h.read).not.toHaveBeenCalled()
  })

  it('does not treat a stale null title hint as durable coverage', async () => {
    const target = record('stale-null')
    const h = harness({
      records: [target],
      cachedSnapshot: () => ({ asOfSeq: -1, values: { title: null } }),
    })

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)
  })

  it('does not mark a lifecycle attempted when the cache no longer covers it', async () => {
    const target = record('evicted-after-put')
    const h = harness({
      records: [target],
      cachedSnapshot: () => undefined,
      options: { failureBackoffMs: 0 },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(2)
  })

  it('waits for the title projection before folding and retries it later', async () => {
    const target = record('title-ready')
    let ready = false
    const h = harness({ records: [target], titleReady: () => ready })

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).not.toHaveBeenCalled()

    ready = true
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.durable).toHaveBeenCalledTimes(1)
  })

  it('re-attempts a recreated id instead of treating the old lifecycle as covered', async () => {
    const older = record('recreated', { createdAt: 1 })
    const newer = { ...older, header: { ...older.header, createdAt: 2 } }
    let current = older
    const read = vi.fn(async () => logFor(current))
    const h = harness({ records: [older], read })

    h.backfill.schedule([older])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)

    current = newer
    h.backfill.schedule([newer])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(2)
  })

  it('backs off a failed session and retries it only after the boundary', async () => {
    let now = 0
    const target = record('failing')
    const read = vi.fn(async (): Promise<StableColdLog> => { throw new Error('disk detached') })
    const h = harness({
      records: [target],
      read,
      options: { failureBackoffMs: 500, now: () => now },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(read).toHaveBeenCalledTimes(1)

    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(read).toHaveBeenCalledTimes(1)

    now = 600
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('marks no-title and empty logs attempted so repeated lists do not reread them', async () => {
    const empty = record('empty')
    const untitled = record('untitled')
    const read = vi.fn(async (id: SessionIdType) => {
      const target = id === empty.header.id ? empty : untitled
      return logFor(target, id === empty.header.id ? 0 : 1)
    })
    const h = harness({
      records: [empty, untitled],
      read,
      summarize: target => summaryFor(target, null),
    })

    h.backfill.schedule([empty, untitled])
    await h.backfill.drain()
    expect(read).toHaveBeenCalledTimes(2)
    expect(h.durable).toHaveBeenCalledTimes(2)
    expect(h.notify).not.toHaveBeenCalled()

    h.backfill.schedule([empty, untitled])
    await h.backfill.drain()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('stops after disposal even when the in-flight read later resolves', async () => {
    const target = record('cancelled')
    const pending = Promise.withResolvers<StableColdLog>()
    const read = vi.fn(() => pending.promise)
    const h = harness({ records: [target], read })

    h.backfill.schedule([target])
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
    h.backfill.dispose()
    pending.resolve(logFor(target))
    await h.backfill.drain()

    expect(h.durable).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('keeps a single read in flight at a time', async () => {
    const records = Array.from({ length: 5 }, (_, index) => record(`serial-${String(index)}`))
    let active = 0
    let maximum = 0
    const read = vi.fn(async (id: SessionIdType) => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      const target = records.find(candidate => candidate.header.id === id)
      if (target === undefined) throw new Error('missing record')
      return logFor(target)
    })
    const h = harness({ records, read })

    h.backfill.schedule(records)
    await h.backfill.drain()

    expect(maximum).toBe(1)
  })

  it('drops a cold notification when a live attach races the durable put', async () => {
    const target = record('live-race')
    let live = false
    let covered = false
    let durableCalls = 0
    const gate = Promise.withResolvers<undefined>()
    const durable = vi.fn(async () => {
      durableCalls += 1
      if (durableCalls === 1) {
        await gate.promise
      }
      covered = true
      return { asOfSeq: SessionSeq(0), values: {} }
    })
    const h = harness({
      records: [target],
      isLive: () => live,
      cachedSnapshot: () => covered
        ? { asOfSeq: SessionSeq(0), values: { title: 'Recovered title' } }
        : undefined,
      coldSnapshotDurable: durable,
    })

    h.backfill.schedule([target])
    await vi.waitFor(() => { expect(durable).toHaveBeenCalledTimes(1) })
    live = true
    gate.resolve(undefined)
    await h.backfill.drain()

    // The put completed while the Session was live: no cold added and no
    // lifecycle attempted marker.
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.notify).not.toHaveBeenCalled()

    // Still live: schedule is a no-op for this id. The live checkpoint owns
    // (and may have replaced) the cold row, so simulate it no longer covering.
    covered = false
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)

    // Detach; the missing attempted marker lets a later listing recover it.
    live = false
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: target.header.id,
    }))
  })

  it('drops the cold add when the post-put lifecycle verify refuses', async () => {
    const target = record('post-verify-refused')
    let verified = true
    let covered = false
    let durableCalls = 0
    const gate = Promise.withResolvers<undefined>()
    const durable = vi.fn(async () => {
      durableCalls += 1
      if (durableCalls === 1) await gate.promise
      covered = true
      return { asOfSeq: SessionSeq(0), values: {} }
    })
    const h = harness({
      records: [target],
      cachedSnapshot: () => covered
        ? { asOfSeq: SessionSeq(0), values: { title: 'Recovered title' } }
        : undefined,
      verify: () => verified,
      coldSnapshotDurable: durable,
    })

    h.backfill.schedule([target])
    await vi.waitFor(() => { expect(durable).toHaveBeenCalledTimes(1) })
    // Removal/recreate/migration lands while the put is in flight.
    verified = false
    gate.resolve(undefined)
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.notify).not.toHaveBeenCalled()

    // No id backoff: the next listing can recover immediately.
    verified = true
    covered = false
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('drops the cold add when a live attach lands during the post-put verify', async () => {
    const target = record('post-verify-live')
    let live = false
    let covered = false
    let verifyCalls = 0
    const durable = vi.fn(async () => {
      covered = true
      return { asOfSeq: SessionSeq(0), values: {} }
    })
    const h = harness({
      records: [target],
      isLive: () => live,
      cachedSnapshot: () => covered
        ? { asOfSeq: SessionSeq(0), values: { title: 'Recovered title' } }
        : undefined,
      verify: async () => {
        verifyCalls += 1
        if (verifyCalls === 1) {
          await Promise.resolve()
          live = true
        }
        return true
      },
      coldSnapshotDurable: durable,
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(verifyCalls).toBe(1)
    expect(h.notify).not.toHaveBeenCalled()

    // Detach and retry; the second verify no longer attaches live.
    live = false
    covered = false
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('notifies only summaries carrying a visible title', async () => {
    const titled = record('titled')
    const untitled = record('untitled')
    const h = harness({
      records: [titled, untitled],
      summarize: target => summaryFor(target, target.header.id === titled.header.id ? 'Visible title' : null),
    })

    h.backfill.schedule([titled, untitled])
    await h.backfill.drain()

    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: titled.header.id,
    }))
  })

  it('restarts for a schedule enqueued between run resolution and the finalizer', async () => {
    const late = record('late-finalizer')
    const h = harness({ records: [late] })

    h.backfill.schedule([])
    queueMicrotask(() => { h.backfill.schedule([late]) })
    await vi.waitFor(() => { expect(h.read).toHaveBeenCalledTimes(1) }, { timeout: 1_000 })
    await h.backfill.drain()

    expect(h.durable).toHaveBeenCalledTimes(1)
  })

  it('restarts a retained queue when the title becomes ready before the finalizer', async () => {
    const target = record('finalizer-title-ready')
    let titleChecks = 0
    const h = harness({
      records: [target],
      titleReady: () => {
        titleChecks += 1
        return titleChecks > 2
      },
      options: { titleWaitMs: 0 },
    })

    h.backfill.schedule([target])
    await vi.waitFor(() => { expect(h.read).toHaveBeenCalledTimes(1) }, { timeout: 1_000 })
    await h.backfill.drain()

    expect(h.durable).toHaveBeenCalledTimes(1)
  })

  it('does not spin after a title-wait timeout with retained work', async () => {
    const target = record('queued-without-title')
    let ready = false
    let titleChecks = 0
    const h = harness({
      records: [target],
      titleReady: () => {
        titleChecks += 1
        return ready
      },
      options: { titleWaitMs: 0 },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()
    const checksAfterTimeout = titleChecks
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(titleChecks).toBe(checksAfterTimeout)
    expect(h.read).not.toHaveBeenCalled()

    // The retained queue is still recoverable by a later schedule.
    ready = true
    h.backfill.schedule([target])
    await h.backfill.drain()
    expect(h.read).toHaveBeenCalledTimes(1)
  })

  it('waits for a late title projection before folding', async () => {
    const target = record('late-title')
    let ready = false
    const h = harness({
      records: [target],
      titleReady: () => ready,
      options: { titleRetryMs: 1, titleWaitMs: 1_000 },
    })

    h.backfill.schedule([target])
    setTimeout(() => { ready = true }, 5)
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.durable).toHaveBeenCalledTimes(1)
  })

  it('leaves the queue for a later listing when the title wait expires', async () => {
    const target = record('missing-title')
    const h = harness({
      records: [target],
      titleReady: () => false,
      options: { titleWaitMs: 0 },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.read).not.toHaveBeenCalled()
  })

  it('stops a title wait when the lifetime is canceled', async () => {
    const target = record('cancel-title-wait')
    const h = harness({
      records: [target],
      titleReady: () => false,
      options: { titleRetryMs: 1, titleWaitMs: 1_000 },
    })

    h.backfill.schedule([target])
    h.backfill.dispose()
    await h.backfill.drain()

    expect(h.read).not.toHaveBeenCalled()
  })

  it('skips the fold if the title unit disappears during the read', async () => {
    const target = record('title-during-read')
    let checks = 0
    const h = harness({
      records: [target],
      titleReady: () => {
        checks += 1
        return checks === 1
      },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.durable).not.toHaveBeenCalled()
  })

  it('ignores scheduling after disposal and tolerates repeated disposal', async () => {
    const target = record('disposed')
    const h = harness({ records: [target] })

    h.backfill.dispose()
    h.backfill.dispose()
    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.read).not.toHaveBeenCalled()
  })

  it('starts nothing for an empty schedule', async () => {
    const h = harness({ records: [] })

    h.backfill.schedule([])
    await h.backfill.drain()

    expect(h.read).not.toHaveBeenCalled()
  })

  it('stops a batch when cancellation lands between items', async () => {
    const records = [record('first'), record('second')]
    let yields = 0
    const backfill: { current?: ColdTitleBackfill } = {}
    const h = harness({
      records,
      options: {
        yieldBetween: async () => {
          yields += 1
          if (yields === 1) backfill.current?.dispose()
        },
      },
    })
    backfill.current = h.backfill

    h.backfill.schedule(records)
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(1)
  })

  it('backs off an absent or foreign read result', async () => {
    const absent = record('absent')
    const foreign = record('foreign')
    const otherLog = logFor(record('other'))
    const h = harness({
      records: [absent, foreign],
      read: async id => id === absent.header.id ? undefined : otherLog,
    })

    h.backfill.schedule([absent, foreign])
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.durable).not.toHaveBeenCalled()
  })

  it('leaves a session that attaches during the read alone', async () => {
    const target = record('live-read')
    let checks = 0
    const h = harness({
      records: [target],
      isLive: () => {
        checks += 1
        return checks >= 2
      },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.durable).not.toHaveBeenCalled()
  })

  it('backs off an inherited cut beyond the stored prefix', async () => {
    const target = record('inherited-cut')
    const h = harness({
      records: [target],
      read: async () => ({
        ...logFor(target, 1),
        inheritedEventCount: SessionLogOffset(2),
        storedEventCount: 1,
      }),
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.durable).not.toHaveBeenCalled()
  })

  it('backs off a refused durable write', async () => {
    const h = harness({
      records: [record('refused-write')],
      coldSnapshotDurable: async () => undefined,
    })

    h.backfill.schedule([record('refused-write')])
    await h.backfill.drain()

    expect(h.notify).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after the post-put verify', async () => {
    const target = record('cancel-post-verify')
    const backfill: { current?: ColdTitleBackfill } = {}
    const h = harness({
      records: [target],
      verify: async () => {
        backfill.current?.dispose()
        return true
      },
    })
    backfill.current = h.backfill

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.notify).not.toHaveBeenCalled()
  })

  it('refuses the pre-put verify once disposed', async () => {
    const target = record('cancel-guard')
    const backfill: { current?: ColdTitleBackfill } = {}
    const h = harness({
      records: [target],
      coldSnapshotDurable: async (_meta, _inherited, _through, _events, options) => {
        backfill.current?.dispose()
        const allowed = await options?.guard?.()
        return allowed ? { asOfSeq: SessionSeq(0), values: {} } : undefined
      },
    })
    backfill.current = h.backfill

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.notify).not.toHaveBeenCalled()
  })

  it('refuses the pre-put verify once live', async () => {
    const target = record('live-guard')
    let live = false
    const h = harness({
      records: [target],
      isLive: () => live,
      coldSnapshotDurable: async (_meta, _inherited, _through, _events, options) => {
        live = true
        const allowed = await options?.guard?.()
        return allowed ? { asOfSeq: SessionSeq(0), values: {} } : undefined
      },
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.notify).not.toHaveBeenCalled()
  })

  it('silently stops a failure that races disposal', async () => {
    const target = record('cancel-error')
    const backfill: { current?: ColdTitleBackfill } = {}
    const h = harness({
      records: [target],
      read: async () => {
        backfill.current?.dispose()
        throw new Error('after dispose')
      },
    })
    backfill.current = h.backfill

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.notify).not.toHaveBeenCalled()
  })

  it('reports an Error failure with onDebug', async () => {
    const onDebug = vi.fn()
    const h = harness({
      records: [record('debug-error')],
      read: async () => { throw new Error('boom') },
      onDebug,
    })

    h.backfill.schedule([record('debug-error')])
    await h.backfill.drain()

    expect(onDebug).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })

  it('reports a non-Error failure with onDebug', async () => {
    const onDebug = vi.fn()
    const h = harness({
      records: [record('debug-non-error')],
      read: async () => { throw new NonErrorFailure() },
      onDebug,
    })

    h.backfill.schedule([record('debug-non-error')])
    await h.backfill.drain()

    expect(onDebug).toHaveBeenCalledWith(expect.stringContaining('plain failure'))
  })

  it('keys the attempted lifecycle from a read header without cwd', async () => {
    const target = record('cwd-fallback')
    const headerWithoutCwd = structuredClone(target.header)
    delete (headerWithoutCwd as { cwd?: string }).cwd
    const log = { ...logFor(target, 1), header: headerWithoutCwd }
    const h = harness({ records: [target], read: async () => log })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('keys a seeded attempted lifecycle', async () => {
    const target = record('seeded-lifecycle', { isSeeded: true })
    const h = harness({ records: [target] })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('treats a predecessor title as coverage', async () => {
    const target = record('predecessor')
    const h = harness({
      records: [target],
      cachedSnapshot: () => undefined,
      cachedPredecessorTitle: () => ({ asOfSeq: SessionSeq(0), values: { title: 'Predecessor title' } }),
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.read).not.toHaveBeenCalled()
  })

  it('does not treat an empty title as visible coverage', async () => {
    const target = record('empty-title')
    const h = harness({
      records: [target],
      cachedSnapshot: () => ({ asOfSeq: SessionSeq(0), values: { title: '' } }),
      summarize: source => summaryFor(source, ''),
    })

    h.backfill.schedule([target])
    await h.backfill.drain()

    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.notify).not.toHaveBeenCalled()
  })
})
