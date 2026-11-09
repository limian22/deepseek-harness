/**
 * Durable cold-read seam: one stored prefix returned only while the backing
 * artifact revision is unchanged across the read. Synthetic interrupted-turn
 * closers are counted separately so a write-back can never fold them.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId as SessionIdType,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { readStableColdLog } from '../src/cold-read.ts'

interface StoredEntry {
  readonly header: SessionHeader
  events: SessionEvent[]
  revision: string
  formatStatus?: 'current' | 'migration-required'
  inheritedEventCount?: SessionLogOffsetType
}

interface Hooks {
  /** Runs inside `open`, before the handle read resolves. */
  onOpen?: (entry: StoredEntry) => void
}

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 10,
    isSeeded: false,
    cwd: '/workspace',
    ...extra,
  }
}

/** One interrupted turn: the cold read balances it with a synthetic closer. */
function interruptedLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: SessionSeq(1),
      time: 2,
      data: createUserMessage({ content: [{ type: 'text', text: 'crashed' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
  ]
}

function stubPersistence(store: Map<SessionIdType, StoredEntry>, hooks: Hooks = {}) {
  const calls = { open: 0, stat: 0 }
  const stat = (
    id: SessionIdType,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> => {
    calls.stat += 1
    options?.signal?.throwIfAborted()
    const entry = store.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.header),
      revision: SessionPersistenceRevision(entry.revision),
      ...entry.formatStatus === undefined ? {} : { formatStatus: entry.formatStatus },
    })
  }
  const open = (
    id: SessionIdType,
    access: SessionAccess,
    options?: { signal?: AbortSignal },
  ): Promise<SessionHandle> => {
    calls.open += 1
    options?.signal?.throwIfAborted()
    const entry = store.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    hooks.onOpen?.(entry)
    const handle: SessionHandle = {
      id,
      header: structuredClone(entry.header),
      inheritedEventCount: entry.inheritedEventCount ?? SessionLogOffset(0),
      access,
      read: (
        _offset?: number,
        _length?: number,
        readOptions?: SessionHandleReadOptions,
      ): Promise<SessionHandleReadResult> => {
        readOptions?.signal?.throwIfAborted()
        return Promise.resolve({
          eventState: 'detached',
          events: structuredClone(entry.events),
        })
      },
      append: () => Promise.reject(new SessionReadOnlyError(id, 'append')),
      flush: () => Promise.reject(new SessionReadOnlyError(id, 'flush')),
      close: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }
    return Promise.resolve(handle)
  }
  return { persistence: { stat, open } as never, calls }
}

describe('readStableColdLog', () => {
  it('separates the stored prefix from synthetic interrupted-turn closers', async () => {
    const meta = header('interrupted-stable')
    const store = new Map([[meta.id, { header: meta, events: interruptedLog(), revision: 'r1', formatStatus: 'current' as const }]])
    const { persistence } = stubPersistence(store)

    const observed = await readStableColdLog(persistence, meta.id)

    expect(observed).toBeDefined()
    expect(observed?.revision).toBe(SessionPersistenceRevision('r1'))
    expect(observed?.storedEventCount).toBe(2)
    expect(observed?.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(observed?.inheritedEventCount).toBe(SessionLogOffset(0))
  })

  it('returns undefined when the artifact revision changes during the read', async () => {
    const meta = header('changed-revision')
    const entry: StoredEntry = { header: meta, events: interruptedLog(), revision: 'r1', formatStatus: 'current' }
    const store = new Map([[meta.id, entry]])
    const { persistence } = stubPersistence(store, {
      onOpen: (opened) => { opened.revision = 'r2' },
    })

    await expect(readStableColdLog(persistence, meta.id)).resolves.toBeUndefined()
  })

  it('refuses a migration-required source without opening its body', async () => {
    const meta = header('migration-required')
    const store = new Map([[meta.id, { header: meta, events: interruptedLog(), revision: 'r1', formatStatus: 'migration-required' as const }]])
    const { persistence, calls } = stubPersistence(store)

    await expect(readStableColdLog(persistence, meta.id)).resolves.toBeUndefined()
    expect(calls.open).toBe(0)
  })

  it('refuses a source that disappears between the snapshot and the read', async () => {
    const meta = header('removed-during-read')
    const entry: StoredEntry = { header: meta, events: interruptedLog(), revision: 'r1', formatStatus: 'current' }
    const store = new Map([[meta.id, entry]])
    const { persistence } = stubPersistence(store, {
      onOpen: () => { store.delete(meta.id) },
    })

    await expect(readStableColdLog(persistence, meta.id)).resolves.toBeUndefined()
  })

  it('refuses a seeded header whose inherited cut exceeds the stored prefix', async () => {
    const meta = header('inherited-too-large', { isSeeded: true })
    const store = new Map([[meta.id, {
      header: meta,
      events: interruptedLog(),
      revision: 'r1',
      formatStatus: 'current' as const,
      inheritedEventCount: SessionLogOffset(3),
    }]])
    const { persistence } = stubPersistence(store)

    await expect(readStableColdLog(persistence, meta.id)).resolves.toBeUndefined()
  })

  it('returns a defined empty prefix for an empty stored log', async () => {
    const meta = header('empty-stored')
    const store = new Map([[meta.id, { header: meta, events: [] as SessionEvent[], revision: 'r1', formatStatus: 'current' as const }]])
    const { persistence } = stubPersistence(store)

    const observed = await readStableColdLog(persistence, meta.id)

    expect(observed?.storedEventCount).toBe(0)
    expect(observed?.events).toEqual([])
  })

  it('refuses a snapshot without a proven current format', async () => {
    const meta = header('pending-format')
    const store = new Map([[meta.id, { header: meta, events: interruptedLog(), revision: 'r1' }]])
    const { persistence, calls } = stubPersistence(store)

    await expect(readStableColdLog(persistence, meta.id)).resolves.toBeUndefined()
    expect(calls.open).toBe(0)
  })
})
