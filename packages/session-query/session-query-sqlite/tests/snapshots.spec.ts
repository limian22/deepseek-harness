import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_QUERY_SNAPSHOT_MAX_BYTES,
  SESSION_QUERY_SNAPSHOT_MAX_ENTRIES,
  SESSION_QUERY_SNAPSHOT_MAX_ROWS,
  SESSION_QUERY_SNAPSHOT_TTL_MS,
  SnapshotStore,
  type SnapshotLimits,
} from '../src/snapshots.ts'

afterEach(() => {
  vi.useRealTimers()
})

const unlimited: SnapshotLimits = {
  ttlMs: SESSION_QUERY_SNAPSHOT_TTL_MS,
  maxEntries: SESSION_QUERY_SNAPSHOT_MAX_ENTRIES,
  maxRows: SESSION_QUERY_SNAPSHOT_MAX_ROWS,
  maxBytes: SESSION_QUERY_SNAPSHOT_MAX_BYTES,
}

describe('SnapshotStore', () => {
  it('captures hits and returns them with the owning payload', () => {
    const store = new SnapshotStore<string, { owner: string }>(unlimited)
    const snapshot = store.store('fingerprint', ['first', 'second'], { owner: 'target' })

    expect(snapshot.fingerprint).toBe('fingerprint')
    expect(snapshot.rows).toEqual(['first', 'second'])
    expect(snapshot.meta).toEqual({ owner: 'target' })
    expect(store.take(snapshot.id)).toBe(snapshot)
    expect(store.take('unknown')).toBeUndefined()
  })

  it('keeps at most the configured number of hits per capture', () => {
    const store = new SnapshotStore<string, undefined>({ ...unlimited, maxRows: 2 })
    const snapshot = store.store('fingerprint', ['a', 'b', 'c'], undefined)

    expect(snapshot.rows).toEqual(['a', 'b'])
  })

  it('drops captures older than the configured lifetime', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const store = new SnapshotStore<string, undefined>({ ...unlimited, ttlMs: 1_000 })
    const snapshot = store.store('fingerprint', ['a'], undefined)

    vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'))

    expect(store.take(snapshot.id)).toBeUndefined()
  })

  it('evicts the oldest capture when the entry limit is reached', () => {
    const store = new SnapshotStore<string, undefined>({ ...unlimited, maxEntries: 2 })
    const first = store.store('first', ['a'], undefined)
    const second = store.store('second', ['b'], undefined)
    const third = store.store('third', ['c'], undefined)

    expect(store.take(first.id)).toBeUndefined()
    expect(store.take(second.id)?.rows).toEqual(['b'])
    expect(store.take(third.id)?.rows).toEqual(['c'])
  })

  it('keeps a capture that is still being paged ahead of newly stored ones', () => {
    const store = new SnapshotStore<string, undefined>({ ...unlimited, maxEntries: 2 })
    const older = store.store('older', ['a'], undefined)
    const newer = store.store('newer', ['b'], undefined)

    expect(store.take(older.id)?.rows).toEqual(['a'])
    store.store('third', ['c'], undefined)

    expect(store.take(older.id)?.rows).toEqual(['a'])
    expect(store.take(newer.id)).toBeUndefined()
  })

  it('evicts captures that would exceed the byte budget', () => {
    const store = new SnapshotStore<string, undefined>({ ...unlimited, maxBytes: 12 })
    const first = store.store('first', ['aaaa'], undefined)
    const second = store.store('second', ['bbbb'], undefined)

    expect(store.take(first.id)).toBeUndefined()
    expect(store.take(second.id)?.rows).toEqual(['bbbb'])
  })

  it('does not store a capture that alone exceeds the byte budget', () => {
    const store = new SnapshotStore<string, undefined>({ ...unlimited, maxBytes: 1 })
    const snapshot = store.store('oversized', ['aaaa'], undefined)

    expect(snapshot).toBeUndefined()
  })

  it('forgets every capture when cleared', () => {
    const store = new SnapshotStore<string, undefined>(unlimited)
    const snapshot = store.store('fingerprint', ['a'], undefined)

    store.clear()

    expect(store.take(snapshot.id)).toBeUndefined()
  })
})
