import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistenceListOptions,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine, {
  SESSION_QUERY_SNAPSHOT_MAX_ROWS,
  SESSION_QUERY_SNAPSHOT_TTL_MS,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-query-sqlite'
import {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SessionQueryError,
  SessionSearchCursor,
  type SessionAvailability,
  type SessionQueryErrorCode,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

function header(id: string, createdAt = 1, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, ...extra }
}

function messageEvents(text: string, time = 1): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    data: createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }]
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

function replaceCursorOffset(
  cursor: ReturnType<typeof SessionSearchCursor>,
  offset: number,
): ReturnType<typeof SessionSearchCursor> {
  return mutateCursor(cursor, { offset })
}

function mutateCursor(
  cursor: ReturnType<typeof SessionSearchCursor>,
  patch: Record<string, unknown>,
): ReturnType<typeof SessionSearchCursor> {
  const payload = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  return SessionSearchCursor(Buffer.from(JSON.stringify({ ...payload, ...patch }), 'utf8').toString('base64url'))
}

async function collectSessionIds(ctx: Context, text: string): Promise<SessionIdType[]> {
  const ids: SessionIdType[] = []
  let cursor: ReturnType<typeof SessionSearchCursor> | undefined
  do {
    const page = await ctx.sessionQuery.searchSessions({
      query: text,
      limit: 1,
      ...cursor === undefined ? {} : { cursor },
    })
    ids.push(...page.items.map(item => item.header.id))
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return ids
}

class TestHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)

  constructor(
    readonly id: SessionIdType,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
  ) {}

  async read(_offset = 0, _length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    TestPersistence.reads.set(this.id, (TestPersistence.reads.get(this.id) ?? 0) + 1)
    TestPersistence.readSignals.push(options?.signal)
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    if (TestPersistence.readFailures.has(this.id)) throw new Error(`stored log for "${this.id}" is unreadable`)
    const entry = TestPersistence.entries.get(this.id)
    if (entry === undefined) throw new SessionPersistenceNotFoundError(this.id)
    await TestPersistence.readEffect?.(entry, options?.signal)
    TestPersistence.readEffect = undefined
    return { eventState: 'detached', events: structuredClone(entry.events) }
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    if (this.access === 'read') return Promise.reject(new SessionReadOnlyError(this.id, 'append'))
    const entry = TestPersistence.entries.get(this.id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(this.id))
    entry.events.push(...structuredClone(events))
    TestPersistence.revisions.set(this.id, ++TestPersistence.nextRevision)
    return Promise.resolve()
  }

  flush(): Promise<void> {
    if (this.access === 'read') return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

class TestPersistence extends SessionPersistence {
  static entries = new Map<SessionIdType, { meta: SessionHeader; events: SessionEvent[] }>()
  static revisions = new Map<SessionIdType, number>()
  static nextRevision = 0
  static reads = new Map<SessionIdType, number>()
  static readSignals: Array<AbortSignal | undefined> = []
  static listSignals: Array<AbortSignal | undefined> = []
  static readEffect: ((
    entry: { meta: SessionHeader; events: SessionEvent[] },
    signal?: AbortSignal,
  ) => void | Promise<void>) | undefined
  static readFailures = new Set<SessionIdType>()
  static listGate: Promise<void> | undefined
  static listStarted: (() => void) | undefined
  static listEffect: ((signal?: AbortSignal) => void | Promise<void>) | undefined
  static listOverride: (() => SessionPersistenceSnapshot[]) | undefined
  static failure: unknown

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map()
    this.revisions = new Map()
    this.reads = new Map()
    this.readSignals = []
    this.listSignals = []
    this.readEffect = undefined
    this.readFailures = new Set()
    for (const entry of entries) this.set(entry)
    this.listGate = undefined
    this.listStarted = undefined
    this.listEffect = undefined
    this.listOverride = undefined
    this.failure = undefined
  }

  static set(entry: { meta: SessionHeader; events: SessionEvent[] }): void {
    this.entries.set(entry.meta.id, structuredClone(entry))
    this.revisions.set(entry.meta.id, ++this.nextRevision)
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    TestPersistence.set({ meta: header, events: [] })
    return Promise.resolve(new TestHandle(header.id, structuredClone(header), 'write'))
  }

  // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
  async flush(): Promise<void> {}

  open(id: SessionIdType, access: SessionAccess): Promise<SessionHandle> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    return Promise.resolve(new TestHandle(id, structuredClone(entry.meta), access))
  }

  stat(id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(id)}`),
    })
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    TestPersistence.listSignals.push(options?.signal)
    TestPersistence.listStarted?.()
    await TestPersistence.listGate
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const snapshots = TestPersistence.listOverride?.()
      ?? [...TestPersistence.entries.values()].map(entry => ({
        header: structuredClone(entry.meta),
        revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(entry.meta.id)}`),
      }))
    await TestPersistence.listEffect?.(options?.signal)
    return snapshots
  }
}

async function liveContext(config: ConstructorParameters<typeof SqliteSessionQueryEngine>[1] = { path: ':memory:' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SqliteSessionQueryEngine, config)
  return ctx
}

describe('SQLite session search', () => {
  it('defaults and validates opening policy and persisted inspection concurrency through its Cordis config', async () => {
    const defaultCtx = await liveContext()
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.openAt).toBe('startup')
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.persistedReadConcurrency)
      .toBe(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY)

    const configuredValue = 2
    const configured = new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      openAt: 'first-search',
      persistedReadConcurrency: configuredValue,
    })
    expect(configured.openAt).toBe('first-search')
    expect(configured.persistedReadConcurrency).toBe(configuredValue)
    const configuredCtx = await liveContext(configured)
    expect((configuredCtx.sessionQuery as SqliteSessionQueryEngine).config.persistedReadConcurrency)
      .toBe(configuredValue)

    for (const persistedReadConcurrency of [0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SqliteSessionQueryEngine.Config({
        path: ':memory:',
        persistedReadConcurrency,
      })).toThrow()
    }
    expect(() => new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      openAt: 'later' as never,
    })).toThrow()
  })

  it('mounts and disposes first-search mode without opening its database', async () => {
    const path = await temporaryPath('unopened.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, {
      path,
      openAt: 'first-search',
    })

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await search.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses search in never mode while inherited reads and traces keep working', async () => {
    const path = await temporaryPath('never-mode.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path, openAt: 'never' })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    expect(service.config.openAt).toBe('never')

    const parent = SessionId('never-parent')
    const child = SessionId('never-child')
    ctx.sessions.create(parent, { seed: messageEvents('never opened needle'), meta: { createdAt: 10 } })
    ctx.sessions.create(child, { meta: { parentSession: parent, createdAt: 20 } })

    await expect(service.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SEARCH_DISABLED'))
    await expect(service.searchEvents({ sessionId: parent, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SEARCH_DISABLED'))

    expect((await service.listSessions()).map(record => record.header.id).sort())
      .toEqual([child, parent])
    const lineage = await service.traceSession(parent)
    expect(lineage.complete).toBe(true)
    expect(lineage.descendants.map(node => node.session.header.id)).toEqual([child])

    // The disabled index never touches the filesystem, in mount, use, or disposal.
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await search.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('opens once on the first search and reuses readiness for later searches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, {
      path: ':memory:',
      openAt: 'first-search',
    })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const internals = service as unknown as { _open(): Promise<void> }
    const open = vi.spyOn(internals, '_open')

    await expect(service.searchSessions({ query: 'first' })).resolves.toEqual({ items: [] })
    await expect(service.searchSessions({ query: 'second' })).resolves.toEqual({ items: [] })

    expect(open).toHaveBeenCalledOnce()
  })

  it('shares one readiness promise across concurrent first searches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, {
      path: ':memory:',
      openAt: 'first-search',
    })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const internals = service as unknown as { _open(): Promise<void> }
    const originalOpen = internals._open.bind(internals)
    const release = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const open = vi.spyOn(internals, '_open').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      await originalOpen()
    })

    const first = service.searchSessions({ query: 'first' })
    const second = service.searchSessions({ query: 'second' })
    await started.promise
    expect(open).toHaveBeenCalledOnce()
    release.resolve(undefined)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { items: [] },
      { items: [] },
    ])
    expect(open).toHaveBeenCalledOnce()
  })

  it('acceptance: keeps a filtered match beyond the global candidate cap', async () => {
    const ctx = await liveContext()
    try {
      const noise = Array.from({ length: 2100 }, (_, index) => ({
        ...messageEvents('needle')[0]!, seq: SessionSeq(index),
      }))
      ctx.sessions.create(SessionId('candidate-noise'), { seed: noise })
      ctx.sessions.create(SessionId('candidate-target'), {
        seed: messageEvents(`needle ${'unrelated '.repeat(100)}`), meta: { cwd: '/acceptance' },
      })
      const page = await ctx.sessionQuery.searchSessions({
        query: 'needle', sessionFilters: [{ kind: 'id', values: [SessionId('candidate-target')] }],
      })
      expect(page.items.map(item => item.header.id)).toEqual([SessionId('candidate-target')])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('acceptance: keeps later matching sessions when one session fills the candidate cap', async () => {
    const ctx = await liveContext()
    try {
      const noise = Array.from({ length: 2100 }, (_, index) => ({
        ...messageEvents('needle')[0]!, seq: SessionSeq(index),
      }))
      ctx.sessions.create(SessionId('candidate-noise'), { seed: noise })
      ctx.sessions.create(SessionId('candidate-target'), { seed: messageEvents(`needle ${'unrelated '.repeat(100)}`) })
      const ids = await collectSessionIds(ctx, 'needle')
      expect(new Set(ids)).toEqual(new Set([SessionId('candidate-noise'), SessionId('candidate-target')]))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('acceptance: keeps persisted filtered matches beyond the candidate cap', async () => {
    TestPersistence.reset([
      { meta: header('persisted-noise'), events: Array.from({ length: 2100 }, (_, index) => ({
        ...messageEvents('needle')[0]!, seq: SessionSeq(index),
      })) },
      { meta: header('persisted-target'), events: messageEvents(`needle ${'unrelated '.repeat(100)}`) },
    ])
    const ctx = await liveContext()
    try {
      await ctx.plugin(TestPersistence)
      const page = await ctx.sessionQuery.searchSessions({
        query: 'needle', sessionFilters: [{ kind: 'id', values: [SessionId('persisted-target')] }],
      })
      expect(page.items.map(item => item.header.id)).toEqual([SessionId('persisted-target')])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('acceptance: preserves match-count ranking and pagination (snapshot=%s)', async (snapshot) => {
    const ctx = await liveContext()
    try {
      ctx.sessions.create(SessionId('short-documents'), {
        seed: Array.from({ length: 2100 }, (_, index) => ({
          ...messageEvents('needle')[0]!, seq: SessionSeq(index),
        })),
      })
      ctx.sessions.create(SessionId('most-matches'), {
        seed: messageEvents(`needle filler needle ${'unrelated '.repeat(1000)}`),
      })
      const first = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, snapshot })
      expect(first.items.map(item => item.header.id)).toEqual([SessionId('most-matches')])
      expect(first.nextCursor).toBeDefined()
      const second = await ctx.sessionQuery.searchSessions({
        query: 'needle', limit: 1, snapshot, cursor: first.nextCursor!,
      })
      expect(second.items.map(item => item.header.id)).toEqual([SessionId('short-documents')])
      expect(second.nextCursor).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('searches two-character Unicode61 tokens in live-only sessions', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 20 })
    const session = ctx.sessions.create(SessionId('live'), {
      seed: messageEvents('inherited context'),
      inheritedEventCount: SessionLogOffset(1),
      // agentPreset rides along: the index rebuilds the header a caller reads,
      // and a session listed under the wrong composition is a lie about what it
      // ran. The full-header comparison below is what pins every column.
      meta: { cwd: '/work', createdAt: 10, isSeeded: true, delegationDepth: 2, agentPreset: 'minimal' },
    })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'An AI helper' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )

    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'AI' }))
      .resolves.toMatchObject({
        session: session.header,
        items: [{ sessionId: session.id, seq: SessionSeq(2), snippet: 'An AI helper' }],
      })
    await expect(ctx.sessionQuery.searchSessions({ query: 'AI' }))
      .resolves.toMatchObject({ items: [{ header: session.header, live: true, persisted: false }] })
  })

  it.each([
    ['文', '文'],
    ['文检', '文检'],
    ['文检𠀀索', '文检𠀀索'],
    ['检𠀀索，报告', '检𠀀索，报告'],
    ['检𠀀索报告', '检𠀀索，报告'],
    ['CAFE前缀', 'café前缀'],
  ])('matches the live phrase %s inside mixed text', async (query, matchedText) => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 16 })
    try {
      const text = `${'filler '.repeat(10)}café前缀中文检𠀀索，报告后缀`
      const session = ctx.sessions.create(SessionId('live-cjk'), { seed: messageEvents(text, 10) })
      const events = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]!.snippet).toContain(matchedText)
      expect(events.items[0]!.snippet).not.toMatch(/[\uFDD0-\uFDD2]/u)
      expect(Array.from(events.items[0]!.snippet).length).toBeLessThanOrEqual(16)
      await expect(ctx.sessionQuery.searchSessions({ query })).resolves.toMatchObject({
        items: [{ header: { id: session.id }, bestMatch: { snippet: events.items[0]!.snippet } }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies session, event type, and time predicates to Han matches', async () => {
    const ctx = await liveContext()
    try {
      const session = ctx.sessions.create(SessionId('target'), {
        seed: [
          ...messageEvents('中文检索案例', 10),
          { type: 'turn/end', seq: SessionSeq(1), time: 10, data: {
            turn: 1, reason: { kind: 'error', error: { message: '中文检索', code: 'UNKNOWN' } },
          } },
        ],
      })
      const peer = ctx.sessions.create(SessionId('peer'), { seed: messageEvents('中文检索', 10) })
      const query = '文检'
      const filters = [{ kind: 'type', values: ['user/message'] }, { kind: 'time', from: 10, to: 10 }] as const
      await expect(ctx.sessionQuery.searchSessions({
        query, sessionFilters: [{ kind: 'id', values: [session.id] }], eventFilters: filters,
      })).resolves.toMatchObject({ items: [{ header: { id: session.id }, bestMatch: { seq: SessionSeq(0) } }] })
      await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query, filters }))
        .resolves.toMatchObject({ items: [{ sessionId: session.id, seq: SessionSeq(0) }] })
      await expect(ctx.sessionQuery.searchEvents({ sessionId: peer.id, query, filters: [{ kind: 'time', from: 11 }] }))
        .resolves.toMatchObject({ items: [] })
      await expect(ctx.sessionQuery.searchSessions({ query: '文索' })).resolves.toMatchObject({ items: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ranks Han hits by original document length and sanitizes reserved markers', async () => {
    const ctx = await liveContext()
    try {
      const short = ctx.sessions.create(SessionId('han-short'), { seed: messageEvents('前缀中文检索后缀', 10) })
      const long = ctx.sessions.create(SessionId('han-long'), { seed: messageEvents('abcdefghijkl中文检索', 10) })
      const marked = ctx.sessions.create(SessionId('han-marked'), {
        seed: messageEvents('中文检索\uFDD0\uFDD1\uFDD2结束', 10),
      })
      const result = await ctx.sessionQuery.searchSessions({ query: '文检' })
      expect(result.items.map(item => item.header.id)).toEqual([short.id, marked.id, long.id])
      await expect(ctx.sessionQuery.searchEvents({ sessionId: marked.id, query: '文检\uFDD2索' }))
        .resolves.toMatchObject({ items: [{ snippet: '中文检索���结束' }] })
      await expect(ctx.sessionQuery.searchEvents({ sessionId: marked.id, query: '\uFDD2' }))
        .resolves.toMatchObject({ items: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('excludes assistant reasoning while indexing visible answer text', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('reasoning'))
    session.append(
      'assistant/message',
      {
        stream: [],
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'private-chain-marker' },
            { type: 'text', text: 'visible-answer-marker' },
          ],
          source: { provider: 'mock', model: 'mock' },
        }),
      },
      { surfaceOp: 'append' },
    )

    await expect(ctx.sessionQuery.searchSessions({ query: 'private-chain-marker' }))
      .resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'visible-answer-marker' }))
      .resolves.toMatchObject({
        items: [{
          header: { id: session.id },
          bestMatch: { snippet: 'visible-answer-marker' },
        }],
      })
  })

  it('searches all surfaces by default and applies metadata before ranking', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 20 })
    const parent = SessionId('parent')
    const events: SessionEvent[] = [
      { type: 'user/message', seq: SessionSeq(0), time: 10, data: createUserMessage({
        content: [{ type: 'text', text: 'needle original' }], source: { kind: 'user' },
      }), surfaceOp: 'append' },
      {
        type: 'assistant/attempt',
        seq: SessionSeq(1),
        time: 11,
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 11, index: 0, dt: [], texts: ['needle raw'] }],
        },
      },
      { type: 'user/message', seq: SessionSeq(2), time: 12, data: createUserMessage({
        content: [{ type: 'text', text: 'needle summary' }], source: { kind: 'test' },
      }), surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] },
      { type: 'turn/end', seq: SessionSeq(3), time: 13, data: { turn: 1, reason: { kind: 'error', error: { message: 'needle failure', code: 'UNKNOWN' } } } },
    ]
    ctx.sessions.create(SessionId('a'), { seed: events, meta: { cwd: '/a', parentSession: parent, createdAt: 20 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('needle peer', 12), meta: { createdAt: 20 } })

    const all = await ctx.sessionQuery.searchEvents({ sessionId: SessionId('a'), query: 'needle' })
    expect(new Set(all.items.map(item => item.surface))).toEqual(new Set(['current', 'shadowed', 'log-only']))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: SessionId('a'),
      query: 'needle',
      filters: [
        { kind: 'seq', from: 2, to: 2 },
        { kind: 'time', from: 12, to: 12 },
        { kind: 'type', values: ['user/message'] },
        { kind: 'surface', values: ['current'] },
      ],
    })).resolves.toMatchObject({ items: [{ seq: SessionSeq(2), surface: 'current' }] })

    const grouped = await ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [
        { kind: 'id', values: [SessionId('a')] },
        { kind: 'cwd', values: ['/a'] },
        { kind: 'created-at', from: 20, to: 20 },
        { kind: 'parent', values: [parent] },
        { kind: 'availability', values: ['live'] },
      ],
      eventFilters: [{ kind: 'surface', values: ['shadowed'] }],
    })
    expect(grouped.items).toHaveLength(1)
    expect(grouped.items[0]).toMatchObject({
      header: { id: SessionId('a'), cwd: '/a', parentSession: parent },
      live: true,
      persisted: false,
      bestMatch: { seq: SessionSeq(0), surface: 'shadowed' },
    })
  })

  it('searches at the supported FTS5 outer-predicate boundary in both scopes', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('predicate-boundary'), {
      seed: messageEvents('needle'),
      meta: { cwd: '/work' },
    })
    const sessionFilters = Array.from(
      { length: 14 },
      () => ({ kind: 'cwd' as const, values: ['/work', null] }),
    )
    const eventFilters = Array.from(
      { length: 13 },
      () => ({ kind: 'type' as const, values: ['user/message' as const] }),
    )

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters }))
      .resolves.toMatchObject({ items: [{ header: { id: session.id } }] })
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters,
    })).resolves.toMatchObject({ items: [{ sessionId: session.id, seq: SessionSeq(0) }] })
  })

  it('rejects unsupported FTS5 outer-predicate counts with typed errors', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('predicate-limit'), { seed: messageEvents('needle') })
    const sessionFilters = Array.from(
      { length: 1_100 },
      () => ({ kind: 'id' as const, values: [session.id] }),
    )
    const eventFilters = Array.from(
      { length: 1_100 },
      () => ({ kind: 'type' as const, values: ['user/message' as const] }),
    )

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: sessionFilters.slice(0, 7),
      eventFilters: eventFilters.slice(0, 8),
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters.slice(0, 14),
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('uses literal phrase tokens, stable ties, and bounded Unicode snippets', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 10, snippetChars: 5 })
    ctx.sessions.create(SessionId('a'), { seed: messageEvents('😀😀 alpha beta BRAID 😀😀', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('c'), { seed: messageEvents('alpha middle beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('d'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('operator'), { seed: messageEvents('needle OR absent', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('only'), { seed: messageEvents('needle only', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('quote'), { seed: messageEvents('say "needle" exactly', 10), meta: { createdAt: 1 } })

    const phrase = await ctx.sessionQuery.searchSessions({ query: 'alpha beta' })
    expect(phrase.items.map(item => item.header.id)).toEqual([SessionId('b'), SessionId('d'), SessionId('a')])
    expect(phrase.items.every(item => Array.from(item.bestMatch.snippet).length <= 5)).toBe(true)
    await expect(ctx.sessionQuery.searchSessions({ query: 'AI' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle OR absent' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('operator') } }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'say "needle"' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('quote') } }] })
    await expect(ctx.sessionQuery.searchSessions({ query: '*' })).resolves.toEqual({ items: [] })
  })

  it('ranks live and persisted matches on one source-comparable contract', async () => {
    const persisted = header('z-persisted')
    TestPersistence.reset([
      { meta: persisted, events: messageEvents('needle needle', 10) },
      ...Array.from({ length: 12 }, (_, index) => ({
        meta: header(`filler-${index}`),
        events: messageEvents('needle', 10),
      })),
    ])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('a-live'), {
      seed: messageEvents('needle needle', 10),
      meta: { createdAt: persisted.createdAt },
    })

    const result = await ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: [SessionId('a-live'), persisted.id] }],
    })
    expect(result.items.map(item => item.header.id)).toEqual([SessionId('a-live'), persisted.id])
    await persistence.dispose()
  })

  it('positions snippets from FTS5 matches across diacritics and punctuation', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 14 })
    const session = ctx.sessions.create(SessionId('snippet'), {
      seed: messageEvents('long long long—café,\nnext value', 10),
    })

    const page = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'CAFE' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.snippet).toContain('café')
    expect(page.items[0]!.snippet).toContain('—')
    expect(page.items[0]!.snippet).not.toContain('\n')
    expect(Array.from(page.items[0]!.snippet).length).toBeLessThanOrEqual(14)
  })

  it('binds cursors to requests and only invalidates within-session pages for target changes', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('target'), {
      seed: [
        ...messageEvents('needle one', 10),
        { ...messageEvents('needle two', 11)[0]!, seq: SessionSeq(1) },
        { ...messageEvents('needle three', 12)[0]!, seq: SessionSeq(2) },
      ],
    })
    ctx.sessions.create(SessionId('other'), { seed: messageEvents('needle other', 10) })

    const eventPage = await ctx.sessionQuery.searchEvents({ sessionId: target.id, query: 'needle', limit: 1 })
    const sessionPage = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    expect(eventPage.nextCursor).toEqual(expect.any(String))
    expect(sessionPage.nextCursor).toEqual(expect.any(String))
    if (eventPage.nextCursor === undefined || sessionPage.nextCursor === undefined) throw new Error('expected cursors')

    const unsafeOffsetCursor = replaceCursorOffset(eventPage.nextCursor, 1e100)
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: unsafeOffsetCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    const eventKeys = eventPage.items.map(item => `${item.sessionId}:${item.seq}`)
    let eventCursor: ReturnType<typeof SessionSearchCursor> | undefined = eventPage.nextCursor
    while (eventCursor !== undefined) {
      const next = await ctx.sessionQuery.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        cursor: eventCursor,
      })
      eventKeys.push(...next.items.map(item => `${item.sessionId}:${item.seq}`))
      eventCursor = next.nextCursor
    }
    expect(eventKeys).toHaveLength(3)
    expect(new Set(eventKeys).size).toBe(eventKeys.length)

    const sessionIds = sessionPage.items.map(item => item.header.id)
    let sessionCursor: ReturnType<typeof SessionSearchCursor> | undefined = sessionPage.nextCursor
    while (sessionCursor !== undefined) {
      const next = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, cursor: sessionCursor })
      sessionIds.push(...next.items.map(item => item.header.id))
      sessionCursor = next.nextCursor
    }
    expect(sessionIds).toHaveLength(2)
    expect(new Set(sessionIds).size).toBe(sessionIds.length)

    ctx.sessions.create(SessionId('unrelated'), { seed: messageEvents('needle unrelated', 20) })
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).resolves.toMatchObject({ items: [{ sessionId: target.id }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, cursor: sessionPage.nextCursor }))
      .rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'different',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    target.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'needle four' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('serves snapshot session pages from the captured ranking while the corpus changes', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    ctx.sessions.create(SessionId('snap-one'), { seed: messageEvents('needle alpha', 10) })
    ctx.sessions.create(SessionId('snap-two'), { seed: messageEvents('needle beta', 20) })
    ctx.sessions.create(SessionId('snap-three'), { seed: messageEvents('needle gamma', 30) })

    const baseline = await collectSessionIds(ctx, 'needle')
    expect(baseline).toHaveLength(3)

    const first = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, snapshot: true })
    if (first.nextCursor === undefined) throw new Error('expected a snapshot cursor')

    ctx.sessions.create(SessionId('snap-four'), { seed: messageEvents('needle delta', 40) })

    const ids = first.items.map(item => item.header.id)
    let cursor: ReturnType<typeof SessionSearchCursor> | undefined = first.nextCursor
    while (cursor !== undefined) {
      const page = await ctx.sessionQuery.searchSessions({
        query: 'needle',
        limit: 1,
        snapshot: true,
        cursor,
      })
      ids.push(...page.items.map(item => item.header.id))
      cursor = page.nextCursor
    }

    expect(ids).toEqual(baseline)
  })

  it('serves snapshot event pages without seeing events appended after the first page', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('snap-events'), {
      seed: [
        ...messageEvents('needle one', 10),
        { ...messageEvents('needle two', 11)[0]!, seq: SessionSeq(1) },
        { ...messageEvents('needle three', 12)[0]!, seq: SessionSeq(2) },
      ],
    })

    const baseline: number[] = []
    let baselineCursor: ReturnType<typeof SessionSearchCursor> | undefined
    do {
      const page = await ctx.sessionQuery.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        ...baselineCursor === undefined ? {} : { cursor: baselineCursor },
      })
      baseline.push(...page.items.map(item => item.seq))
      baselineCursor = page.nextCursor
    } while (baselineCursor !== undefined)
    expect(baseline).toHaveLength(3)

    const first = await ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      snapshot: true,
    })
    if (first.nextCursor === undefined) throw new Error('expected a snapshot cursor')

    target.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'needle four' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const seqs = first.items.map(item => item.seq)
    let cursor: ReturnType<typeof SessionSearchCursor> | undefined = first.nextCursor
    while (cursor !== undefined) {
      const page = await ctx.sessionQuery.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        snapshot: true,
        cursor,
      })
      seqs.push(...page.items.map(item => item.seq))
      cursor = page.nextCursor
    }

    expect(seqs).toEqual(baseline)
  })

  it('keeps snapshot cursors bound to their scope and normalized request', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('snap-bound'), {
      seed: [
        ...messageEvents('needle one', 10),
        { ...messageEvents('needle two', 11)[0]!, seq: SessionSeq(1) },
      ],
    })
    ctx.sessions.create(SessionId('snap-bound-other'), { seed: messageEvents('needle other', 20) })

    const sessions = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, snapshot: true })
    const events = await ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      snapshot: true,
    })
    if (sessions.nextCursor === undefined || events.nextCursor === undefined) {
      throw new Error('expected snapshot cursors')
    }

    await expect(ctx.sessionQuery.searchSessions({
      query: 'differing',
      limit: 1,
      snapshot: true,
      cursor: sessions.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      limit: 1,
      snapshot: false,
      cursor: sessions.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    const legacy = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    if (legacy.nextCursor === undefined) throw new Error('expected a legacy cursor')
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      limit: 1,
      snapshot: true,
      cursor: legacy.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      snapshot: true,
      cursor: sessions.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
  })

  it('expires snapshot cursors after their lifetime while the corpus stays unchanged', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
      ctx.sessions.create(SessionId('snap-expire-one'), { seed: messageEvents('needle alpha', 10) })
      ctx.sessions.create(SessionId('snap-expire-two'), { seed: messageEvents('needle beta', 20) })

      const first = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, snapshot: true })
      if (first.nextCursor === undefined) throw new Error('expected a snapshot cursor')
      const target = ctx.sessions.create(SessionId('snap-expire-events'), {
        seed: [
          ...messageEvents('needle one', 10),
          { ...messageEvents('needle two', 11)[0]!, seq: SessionSeq(1) },
        ],
      })
      const eventFirst = await ctx.sessionQuery.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        snapshot: true,
      })
      if (eventFirst.nextCursor === undefined) throw new Error('expected a snapshot cursor')

      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime() + SESSION_QUERY_SNAPSHOT_TTL_MS + 1)

      await expect(ctx.sessionQuery.searchSessions({
        query: 'needle',
        limit: 1,
        snapshot: true,
        cursor: first.nextCursor,
      })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
      await expect(ctx.sessionQuery.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        snapshot: true,
        cursor: eventFirst.nextCursor,
      })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a generation cursor when an event capture would exceed its row cap', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('snap-event-cap'), {
      seed: Array.from({ length: SESSION_QUERY_SNAPSHOT_MAX_ROWS + 1 }, (_, index) => ({
        ...messageEvents(`needle ${index}`, index + 1)[0]!,
        seq: SessionSeq(index),
      })),
    })

    const first = await ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      snapshot: true,
    })
    if (first.nextCursor === undefined) throw new Error('expected a cursor')

    target.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'needle late' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      snapshot: true,
      cursor: first.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('rejects a snapshot cursor whose binding was altered', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    ctx.sessions.create(SessionId('snap-tamper-one'), { seed: messageEvents('needle alpha', 10) })
    ctx.sessions.create(SessionId('snap-tamper-two'), { seed: messageEvents('needle beta', 20) })

    const first = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, snapshot: true })
    if (first.nextCursor === undefined) throw new Error('expected a snapshot cursor')

    for (const patch of [
      { instance: 'another-instance' },
      { scope: 'events' },
      { snapshot: 42 },
      { offset: '1' },
      { offset: 1.5 },
      { offset: -1 },
    ]) {
      await expect(ctx.sessionQuery.searchSessions({
        query: 'needle',
        limit: 1,
        snapshot: true,
        cursor: mutateCursor(first.nextCursor, patch),
      })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    }

    const second = await ctx.sessionQuery.searchSessions({
      query: 'needle',
      limit: 1,
      snapshot: true,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.header.id).not.toBe(first.items[0]!.header.id)
  })

  it('falls back to a generation cursor when a capture would exceed its row cap', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    for (let index = 0; index <= SESSION_QUERY_SNAPSHOT_MAX_ROWS; index += 1) {
      ctx.sessions.create(SessionId(`snap-cap-${index}`), {
        seed: messageEvents(`needle ${index}`, index + 1),
        meta: { createdAt: index },
      })
    }

    const first = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, snapshot: true })
    if (first.nextCursor === undefined) throw new Error('expected a cursor')

    ctx.sessions.create(SessionId('snap-cap-late'), { seed: messageEvents('needle late', 10_000) })

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      limit: 1,
      snapshot: true,
      cursor: first.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('invalidates session cursors after transient persistence topology changes', async () => {
    TestPersistence.reset()
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    ctx.sessions.create(SessionId('first'), { seed: messageEvents('needle first') })
    ctx.sessions.create(SessionId('second'), { seed: messageEvents('needle second') })
    const page = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    if (page.nextCursor === undefined) throw new Error('expected cursor')

    const persistence = await ctx.plugin(TestPersistence)
    await persistence.dispose()

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      limit: 1,
      cursor: page.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('rejects invalid requests, filters, cursors, and direct config', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 2, maxLimit: 3 })
    const session = ctx.sessions.create(SessionId('valid'), { seed: messageEvents('needle') })
    for (const request of [
      { sessionId: session.id, query: '' },
      { sessionId: session.id, query: 'needle', limit: 0 },
      { sessionId: session.id, query: 'needle', limit: 4 },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'seq', from: 2, to: 1 }] },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'surface', values: ['future'] }] },
      { sessionId: session.id, query: 'bad\0query' },
    ] as const) {
      await expect(ctx.sessionQuery.searchEvents(request as never)).rejects.toBeInstanceOf(Error)
    }
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: ['remote' as never] }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      eventFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      cursor: SessionSearchCursor('not-json'),
    }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      cursor: SessionSearchCursor(Buffer.from('null', 'utf8').toString('base64url')),
    }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(ctx.sessionQuery.searchEvents({ sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    for (const config of [
      { path: '' },
      { path: ':memory:', defaultLimit: 0 },
      { path: ':memory:', maxLimit: 0 },
      { path: ':memory:', defaultLimit: 1e100 },
      { path: ':memory:', maxLimit: 1e100 },
      { path: ':memory:', snippetChars: 0 },
      { path: ':memory:', readWindowMax: -1 },
      { path: ':memory:', persistedReadConcurrency: 0 },
      { path: ':memory:', persistedReadConcurrency: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', preparedSessionCacheSize: 0 },
      { path: ':memory:', preparedSessionCacheSize: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', defaultLimit: 3, maxLimit: 2 },
      { path: ':memory:', openAt: 'later' },
      { path: ':memory:', journalMode: 'memory' },
    ]) {
      const direct = new Context()
      await direct.plugin(SessionStore)
      expect(() => new SqliteSessionQueryEngine(direct, config as never))
        .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
      expect(direct.sessionQuery).toBeUndefined()
    }
  })

  it('rejects aggregate filter bindings above SQLite\'s portable variable limit', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('binding-limit'), { seed: messageEvents('needle') })
    // Each clause is below the ceiling; combined with its sibling and fixed
    // query bindings, the complete statement is not portable.
    const halfPortableLimit = 16_383
    const ids = Array.from(
      { length: halfPortableLimit },
      (_, index) => SessionId(`binding-${index}`),
    )
    const types = Array.from({ length: halfPortableLimit }, () => 'user/message' as const)
    const surfaces = Array.from({ length: halfPortableLimit }, () => 'current' as const)

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
      eventFilters: [{ kind: 'type', values: types }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: [
        { kind: 'type', values: types },
        { kind: 'surface', values: surfaces },
      ],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('rejects one 125,000-value filter list with a typed error', async () => {
    const ctx = await liveContext()
    const ids = Array.from(
      { length: 125_000 },
      (_, index) => SessionId(`oversized-binding-${index}`),
    )

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })
})

describe('SQLite reconciliation and source lifecycle', () => {
  it('owns queued request and filter values before waiting for the serializer', async () => {
    const durable = header('owned')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }
    const blocking = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await started

    const availability: SessionAvailability[] = ['persisted']
    const request: SessionSearchRequest = {
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: availability }],
    }
    const queued = ctx.sessionQuery.searchSessions(request)
    request.query = 'absent'
    availability[0] = 'live'
    release()

    await expect(blocking).resolves.toMatchObject({ items: [{ header: durable }] })
    await expect(queued).resolves.toMatchObject({ items: [{ header: durable }] })
    await persistence.dispose()
  })

  it('mounts persistence dynamically, shadows with TEMP live rows, reveals, and hides on unmount', async () => {
    const shared = header('shared', 10, { cwd: '/work' })
    const durable = header('durable', 5)
    TestPersistence.reset([
      { meta: shared, events: messageEvents('persisted needle') },
      { meta: durable, events: messageEvents('durable needle') },
    ])
    const ctx = await liveContext()
    await expect(ctx.sessionQuery.searchSessions({ query: 'durable' })).resolves.toEqual({ items: [] })
    const persistenceFiber = await ctx.plugin(TestPersistence)

    await expect(ctx.sessionQuery.searchSessions({ query: 'durable' }))
      .resolves.toMatchObject({ items: [{ header: durable, live: false, persisted: true }] })
    const live = ctx.sessions.prepare(shared.id, { meta: { createdAt: 10, cwd: '/work' } })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'live needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(ctx.sessionQuery.searchSessions({ query: 'persisted' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    detach()
    await expect(ctx.sessionQuery.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })

    await persistenceFiber.dispose()
    await expect(ctx.sessionQuery.searchSessions({ query: 'durable' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('does not load a persisted log while the same session is live', async () => {
    const shared = header('checkpointed-live', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    const live = ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: shared.createdAt },
    })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    const persistence = await ctx.plugin(TestPersistence)

    await expect(ctx.sessionQuery.searchSessions({
      query: 'live',
      sessionFilters: [{ kind: 'availability', values: ['persisted'] }],
    })).resolves.toMatchObject({
      items: [{ header: shared, live: true, persisted: true }],
    })
    expect(TestPersistence.reads.get(shared.id)).toBeUndefined()

    detach()
    await expect(ctx.sessionQuery.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    await persistence.dispose()
  })

  it('searches live and cold history during live revision churn and reloads fresh history on detach', async () => {
    const shared = header('churning-live', 10)
    const cold = header('unrelated-cold')
    TestPersistence.reset([
      { meta: shared, events: messageEvents('obsolete needle') },
      { meta: cold, events: messageEvents('cold needle') },
    ])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    await ctx.sessionQuery.searchSessions({ query: 'obsolete' })
    const live = ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: shared.createdAt },
    })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    let lists = 0
    TestPersistence.listEffect = () => {
      lists += 1
      TestPersistence.set({ meta: shared, events: messageEvents('fresh needle') })
    }

    const page = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    expect(page.items).toHaveLength(2)
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ header: shared, live: true, persisted: true }),
      expect.objectContaining({ header: cold, live: false, persisted: true }),
    ]))
    await expect(ctx.sessionQuery.searchEvents({ sessionId: shared.id, query: 'live' }))
      .resolves.toMatchObject({ items: [{ sessionId: shared.id }] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: cold.id, query: 'cold' }))
      .resolves.toMatchObject({ items: [{ sessionId: cold.id }] })
    expect(lists).toBe(6)
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    expect(TestPersistence.reads.get(cold.id)).toBe(1)

    TestPersistence.listEffect = undefined
    detach()
    await expect(ctx.sessionQuery.searchSessions({ query: 'fresh' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'obsolete' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: shared.id, query: 'fresh' }))
      .resolves.toMatchObject({ items: [{ sessionId: shared.id }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(2)
    await persistence.dispose()
  })

  it('fails after one retry when same-ID live owners keep replacing each other', async () => {
    const shared = header('replaced-live', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const prepare = () => ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: shared.createdAt },
    })
    let detach = ctx.sessions.enter(prepare())
    let lists = 0
    TestPersistence.listEffect = () => {
      lists += 1
      detach()
      detach = ctx.sessions.enter(prepare())
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    expect(lists).toBe(4)
    detach()
  })

  it.each(['cold revision', 'persisted header', 'persisted population'] as const)(
    'does not exempt changing %s during live revision churn', async (change) => {
      const shared = header('live-with-unstable-source', 10)
      const cold = header('unstable-cold')
      const added = header('unstable-population')
      TestPersistence.reset([
        { meta: shared, events: messageEvents('persisted needle') },
        { meta: cold, events: messageEvents('cold needle') },
      ])
      const ctx = await liveContext()
      await ctx.plugin(TestPersistence)
      ctx.sessions.create(shared.id, {
        seed: messageEvents('live needle'), meta: { createdAt: shared.createdAt },
      })
      let lists = 0
      TestPersistence.listEffect = () => {
        lists += 1
        TestPersistence.set({ meta: shared, events: messageEvents('persisted needle') })
        if (change === 'cold revision') {
          TestPersistence.set({ meta: cold, events: messageEvents(`cold needle ${lists}`) })
        } else if (change === 'persisted header') {
          TestPersistence.set({ meta: { ...shared, cwd: `/changed-${lists}` }, events: messageEvents('needle') })
        } else if (lists % 2 === 1) {
          TestPersistence.set({ meta: added, events: messageEvents('added needle') })
        } else {
          TestPersistence.entries.delete(added.id)
        }
      }

      await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
        .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
      expect(lists).toBe(4)
    },
  )

  it('reloads cold history when a live owner disappears during revision churn', async () => {
    const shared = header('disappearing-live', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('obsolete needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const live = ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'), meta: { createdAt: shared.createdAt },
    })
    const detach = ctx.sessions.enter(live)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      TestPersistence.set({ meta: shared, events: messageEvents('fresh needle') })
      detach()
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'fresh' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.listSignals).toHaveLength(4)
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
  })

  it('retries a persistence replacement despite live revision churn', async () => {
    const shared = header('live-across-binding-change', 10)
    const cold = header('cold-across-binding-change')
    TestPersistence.reset([
      { meta: shared, events: messageEvents('persisted needle') },
      { meta: cold, events: messageEvents('obsolete needle') },
    ])
    const ctx = await liveContext()
    let persistence = await ctx.plugin(TestPersistence)
    ctx.sessions.create(shared.id, {
      seed: messageEvents('live needle'), meta: { createdAt: shared.createdAt },
    })
    let lists = 0
    TestPersistence.listEffect = async () => {
      lists += 1
      TestPersistence.set({ meta: shared, events: messageEvents('persisted needle') })
      if (lists !== 2) return
      await persistence.dispose()
      TestPersistence.set({ meta: cold, events: messageEvents('replacement needle') })
      persistence = await ctx.plugin(TestPersistence)
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'replacement' }))
      .resolves.toMatchObject({ items: [{ header: cold, live: false, persisted: true }] })
    expect(lists).toBe(4)
    expect(TestPersistence.reads.get(cold.id)).toBe(2)
    expect(TestPersistence.reads.get(shared.id)).toBeUndefined()
    await persistence.dispose()
  })

  it('retries when a live owner attaches during persistence observation', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      ctx.sessions.create(SessionId('attached'), { seed: messageEvents('attached needle') })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'attached' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('attached') } }] })
  })

  it('prefers a live owner that attaches during a persisted read and never mutates the store', async () => {
    const shared = header('attach-during-read', 10)
    const persistedEvents = messageEvents('persisted needle')
    TestPersistence.reset([{ meta: shared, events: persistedEvents }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.readEffect = () => {
      ctx.sessions.create(shared.id, {
        seed: messageEvents('live needle'),
        meta: { createdAt: shared.createdAt },
      })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    // The cold read is observation-only: the stored log is unchanged.
    expect(TestPersistence.entries.get(shared.id)?.events).toEqual(persistedEvents)
  })

  it('retries when one live owner replaces another during persistence observation', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const first = ctx.sessions.prepare(SessionId('first'), { seed: messageEvents('first needle') })
    const detachFirst = ctx.sessions.enter(first)
    ctx.sessions.announce(first)
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      detachFirst()
      ctx.sessions.create(SessionId('second'), { seed: messageEvents('second needle') })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'second' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('second') } }] })
  })

  it('uses the reconciled persistence binding through the query boundary', async () => {
    const durable = header('post-reconcile-unmount')
    TestPersistence.reset([{ meta: durable, events: [
      ...messageEvents('durable needle', 1),
      { ...messageEvents('durable needle again', 2)[0]!, seq: SessionSeq(1) },
    ] }])
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 2 })
    const persistence = await ctx.plugin(TestPersistence)
    const internals = ctx.sessionQuery as unknown as {
      _reconcile(signal: AbortSignal | undefined): Promise<{
        identity: symbol
        service?: SessionPersistence
      }>
    }
    const reconcile = internals._reconcile.bind(internals)
    const boundary = vi.spyOn(internals, '_reconcile').mockImplementation(async (signal) => {
      const binding = await reconcile(signal)
      await persistence.dispose()
      return binding
    })

    const page = await ctx.sessionQuery.searchEvents({
      sessionId: durable.id,
      query: 'needle',
      limit: 1,
    })
    expect(page.items).toMatchObject([{ sessionId: durable.id }])
    expect(page.nextCursor).toEqual(expect.any(String))
    boundary.mockRestore()
    await expect(ctx.sessionQuery.searchEvents({ sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('discards a stale list rejection when persistence unmounts during observation', async () => {
    const durable = header('racing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistenceFiber = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await started
    await persistenceFiber.dispose()
    TestPersistence.failure = new Error('stale backend rejection')
    release()
    await expect(search).resolves.toEqual({ items: [] })
  })

  it('retries against a replacement after the prior binding rejects', async () => {
    const durable = header('replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    let rejectPrior!: (reason: unknown) => void
    TestPersistence.listGate = new Promise<void>((_resolve, reject) => { rejectPrior = reject })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await started
    await prior.dispose()
    TestPersistence.listGate = undefined
    const replacement = await ctx.plugin(TestPersistence)
    rejectPrior(new Error('stale prior binding'))
    await expect(search).resolves.toMatchObject({ items: [{ header: durable }] })
    await replacement.dispose()
  })

  it('reloads a replacement source even when its opaque revisions collide', async () => {
    const durable = header('colliding-replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('old content') }])
    const revision = TestPersistence.revisions.get(durable.id)!
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.searchSessions({ query: 'old' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    await prior.dispose()

    TestPersistence.set({ meta: durable, events: messageEvents('new needle') })
    TestPersistence.revisions.set(durable.id, revision)
    const replacement = await ctx.plugin(TestPersistence)
    const page = await ctx.sessionQuery.searchSessions({ query: 'new needle' })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    expect(page).toMatchObject({ items: [{ header: durable }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'old' })).resolves.toEqual({ items: [] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await replacement.dispose()
  })

  it('retries when a successful observation belongs to a source unmounted during listing', async () => {
    const durable = header('successful-unmount')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.listEffect = async () => {
      lists += 1
      if (lists === 2) await persistence.dispose()
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).resolves.toEqual({ items: [] })
    expect(lists).toBe(2)
  })

  it('retries when the snapshot population changes during observation', async () => {
    const first = header('first')
    const added = header('added-during-list')
    TestPersistence.reset([{ meta: first, events: messageEvents('first needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    }

    const page = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    expect(page.items.map(item => item.header.id).sort()).toEqual([added.id, first.id].sort())
    expect(TestPersistence.reads.get(first.id)).toBe(2)
    expect(TestPersistence.reads.get(added.id)).toBe(1)
  })

  it('fails after one retry when persistence snapshots keep changing', async () => {
    const durable = header('continuous-mutation')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.listEffect = () => {
      lists += 1
      TestPersistence.set({ meta: durable, events: messageEvents(`durable needle ${lists}`) })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    expect(lists).toBe(4)
  })

  it.each([1, 2])('retries if the persistence binding changes at live snapshot %s', async (snapshotList) => {
    const durable = header('live-boundary-retry')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const internals = ctx.sessionQuery as unknown as {
      _persistenceBinding: { identity: symbol; service?: SessionPersistence }
    }
    const originalList = ctx.sessions.list.bind(ctx.sessions)
    let lists = 0
    const list = vi.spyOn(ctx.sessions, 'list').mockImplementation(() => {
      if (++lists === snapshotList) {
        internals._persistenceBinding = {
          ...internals._persistenceBinding,
          identity: Symbol(),
        }
      }
      return originalList()
    })

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    list.mockRestore()
  })

  it('rejects malformed snapshots and preserves typed persistence failures', async () => {
    const durable = header('invalid-snapshot')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    TestPersistence.listOverride = () => 'not-an-array' as never
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listOverride = () => [{ header: durable, revision: 1 as never }]
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listOverride = () => [
      { header: durable, revision: SessionPersistenceRevision('duplicate:1') },
      { header: durable, revision: SessionPersistenceRevision('duplicate:2') },
    ]
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))

    TestPersistence.listOverride = undefined
    const typed = new SessionQueryError('typed persistence failure', 'SESSION_QUERY_PERSISTENCE_FAILED')
    TestPersistence.failure = typed
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).rejects.toBe(typed)
  })

  it('rejects immutable header conflicts between live and persisted sources', async () => {
    const shared = header('conflict', 10, { delegationDepth: 1 })
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: 10, delegationDepth: 2 },
    })

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })

  it('preserves unchanged persisted generations while reconciling new, changed, and deleted rows', { timeout: 20_000 }, async () => {
    const path = await temporaryPath()
    const unchanged = header('unchanged')
    const changed = header('changed')
    const deleted = header('deleted')
    TestPersistence.reset([
      { meta: unchanged, events: messageEvents('unchanged needle') },
      { meta: changed, events: messageEvents('old needle') },
      { meta: deleted, events: messageEvents('deleted needle') },
    ])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const firstPersistence = await first.plugin(TestPersistence)
    const firstSearch = await first.plugin(SqliteSessionQueryEngine, { path })
    await first.sessionQuery.searchSessions({ query: 'needle' })
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await first.sessionQuery.searchSessions({ query: 'needle' })
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await firstSearch.dispose()
    await firstPersistence.dispose()

    const beforeDb = new DatabaseSync(path)
    const beforeRows = beforeDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    beforeDb.close()
    const before = new Map(beforeRows.map(row => [row.id, row.generation]))

    const added = header('added')
    TestPersistence.entries.delete(deleted.id)
    TestPersistence.set({ meta: changed, events: messageEvents('changed needle') })
    TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const secondPersistence = await second.plugin(TestPersistence)
    const secondSearch = await second.plugin(SqliteSessionQueryEngine, { path })
    const result = await second.sessionQuery.searchSessions({ query: 'needle' })
    expect(result.items.map(item => item.header.id).sort()).toEqual([added.id, changed.id, unchanged.id].sort())
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({
      unchanged: 1,
      changed: 2,
      deleted: 1,
      added: 1,
    })
    await secondSearch.dispose()
    await secondPersistence.dispose()

    const afterDb = new DatabaseSync(path)
    const afterRows = afterDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    afterDb.close()
    const after = new Map(afterRows.map(row => [row.id, row.generation]))
    expect(after.get(unchanged.id)).toBe(before.get(unchanged.id))
    expect(after.get(changed.id)).toBeGreaterThan(before.get(changed.id)!)
    expect(after.has(deleted.id)).toBe(false)
    expect(after.has(added.id)).toBe(true)
  })

  it('drops connection-local live overlays on reopen and retains persistent bases', async () => {
    const path = await temporaryPath()
    const shared = header('shared', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const persistence = await first.plugin(TestPersistence)
    const live = first.sessions.create(shared.id, { seed: messageEvents('live needle'), meta: { createdAt: 10 } })
    const search = await first.plugin(SqliteSessionQueryEngine, { path })
    await expect(first.sessionQuery.searchEvents({ sessionId: live.id, query: 'live' })).resolves.toMatchObject({ items: [{}] })
    await search.dispose()
    await persistence.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const persistenceAgain = await second.plugin(TestPersistence)
    const searchAgain = await second.plugin(SqliteSessionQueryEngine, { path })
    await expect(second.sessionQuery.searchSessions({ query: 'live' })).resolves.toEqual({ items: [] })
    await expect(second.sessionQuery.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    await searchAgain.dispose()
    await persistenceAgain.dispose()
  })

  it('refreshes after an external writer replaces a stored log, then reuses the new revision', async () => {
    const durable = header('repair')
    TestPersistence.reset([{ meta: durable, events: messageEvents('before repair') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.searchSessions({ query: 'before' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    // An external writer (resume-time torn-tail repair, or another append)
    // replaces the stored log and moves its revision.
    TestPersistence.set({ meta: durable, events: messageEvents('repaired needle') })

    await expect(ctx.sessionQuery.searchSessions({ query: 'repaired' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await ctx.sessionQuery.searchSessions({ query: 'repaired' })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await persistence.dispose()
  })

  it('recovers on the next search after source and SQLite transaction failures', async () => {
    TestPersistence.reset([{ meta: header('durable'), events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.failure = 'offline'
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    const signal = new AbortController().signal
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = new Error('still offline')
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = undefined
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).resolves.toMatchObject({ items: [{}] })

    const live = ctx.sessions.create(SessionId('live'), { seed: messageEvents('base') })
    await ctx.sessionQuery.searchEvents({ sessionId: live.id, query: 'base' })
    const db = (ctx.sessionQuery as unknown as { _db: DatabaseSync })._db
    db.exec('PRAGMA query_only = ON')
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'retry needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: live.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    db.exec('PRAGMA query_only = OFF')
    // seq 2: one-event seed, end-seed, then the live message.
    await expect(ctx.sessionQuery.searchEvents({ sessionId: live.id, query: 'needle' }))
      .resolves.toMatchObject({ items: [{ seq: SessionSeq(2) }] })
  })
})

describe('SQLite schema, cancellation, and real persistence integration', () => {
  it('creates a new database and WAL sidecars owner-only without changing its parent mode', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    const directory = dirname(path)
    await chmod(directory, 0o755)

    const ctx = await liveContext({ path })
    await ctx.sessionQuery.searchSessions({ query: 'needle' })

    expect((await stat(directory)).mode & 0o777).toBe(0o755)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('creates a persistent rollback journal owner-only', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    const ctx = await liveContext({ path, journalMode: 'persist' })
    await ctx.sessionQuery.searchSessions({ query: 'needle' })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-journal`)).mode & 0o777).toBe(0o600)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('preserves the mode of an existing database file', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    await writeFile(path, '', { mode: 0o644 })
    await chmod(path, 0o644)

    const ctx = await liveContext({ path, journalMode: 'delete' })
    await ctx.sessionQuery.searchSessions({ query: 'needle' })

    expect((await stat(path)).mode & 0o777).toBe(0o644)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('surfaces filesystem failures while pre-creating the database', async () => {
    const path = `${await temporaryPath()}\0`
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)

    await expect(ctx.plugin(SqliteSessionQueryEngine, { path })).rejects.toMatchObject({
      code: 'SESSION_QUERY_INDEX_FAILED',
      cause: { code: 'ERR_INVALID_ARG_VALUE' },
    })
    expect(ctx.sessionQuery).toBeUndefined()
  })

  it('rebuilds version 9 stored text for Han search and reuses the index on reopen', async () => {
    const path = await temporaryPath()
    const meta = header('stored-cjk')
    const text = '前缀中文检𠀀索后缀'
    TestPersistence.reset([{ meta, events: messageEvents(text) }])
    const owner = await liveContext({ path })
    try {
      await owner.plugin(TestPersistence)
      await owner.sessionQuery.searchSessions({ query: text })
    } finally {
      await owner.fiber.dispose()
    }

    const old = new DatabaseSync(path)
    try {
      old.prepare('UPDATE persisted_docs SET text = ?').run(text)
      old.exec('PRAGMA user_version = 9')
    } finally {
      old.close()
    }

    const query = '文检𠀀'
    const rebuilt = await liveContext({ path })
    try {
      await rebuilt.plugin(TestPersistence)
      await expect(rebuilt.sessionQuery.searchSessions({ query })).resolves.toMatchObject({
        items: [{ header: meta, live: false, persisted: true, bestMatch: { snippet: text } }],
      })
      expect(TestPersistence.reads.get(meta.id)).toBe(2)
    } finally {
      await rebuilt.fiber.dispose()
    }

    const reopened = await liveContext({ path })
    try {
      await reopened.plugin(TestPersistence)
      await expect(reopened.sessionQuery.searchEvents({ sessionId: meta.id, query }))
        .resolves.toMatchObject({ items: [{ sessionId: meta.id, snippet: text }] })
      expect(TestPersistence.reads.get(meta.id)).toBe(2)
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
      } finally {
        db.close()
      }
    } finally {
      await reopened.fiber.dispose()
    }
  })

  it('resets a recognized incompatible schema but refuses unknown or foreign tables', { timeout: 20_000 }, async () => {
    const stalePath = await temporaryPath('stale.db')
    const staleOwner = await liveContext({ path: stalePath })
    await (staleOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const stale = new DatabaseSync(stalePath)
    stale.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION - 1}`)
    stale.close()
    const staleCtx = await liveContext({ path: stalePath })
    staleCtx.sessions.create(SessionId('live'), { seed: messageEvents('needle') })
    await staleCtx.sessionQuery.searchSessions({ query: 'needle' })
    await (staleCtx.sessionQuery as SqliteSessionQueryEngine).close()
    const rebuilt = new DatabaseSync(stalePath)
    expect((rebuilt.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(SESSION_QUERY_SQLITE_SCHEMA_VERSION)
    rebuilt.close()

    const augmentedPath = await temporaryPath('augmented.db')
    const augmentedOwner = await liveContext({ path: augmentedPath })
    await (augmentedOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const augmented = new DatabaseSync(augmentedPath)
    augmented.exec('CREATE TABLE unrelated(value TEXT)')
    augmented.exec("INSERT INTO unrelated VALUES ('safe')")
    augmented.exec('PRAGMA user_version = 999')
    augmented.close()
    const augmentedCtx = new Context()
    await augmentedCtx.plugin(SessionStore)
    await augmentedCtx.plugin(SessionProjectionRegistry)
    await expect(augmentedCtx.plugin(SqliteSessionQueryEngine, { path: augmentedPath }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(augmentedCtx.sessionQuery).toBeUndefined()
    const stillAugmented = new DatabaseSync(augmentedPath)
    expect(stillAugmented.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'safe' })
    expect(stillAugmented.prepare('PRAGMA user_version').get()).toEqual({ user_version: 999 })
    stillAugmented.close()

    const currentAugmentedPath = await temporaryPath('current-augmented.db')
    const currentAugmentedOwner = await liveContext({ path: currentAugmentedPath })
    await (currentAugmentedOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const currentAugmented = new DatabaseSync(currentAugmentedPath)
    currentAugmented.exec('CREATE TABLE unrelated(value TEXT)')
    currentAugmented.exec("INSERT INTO unrelated VALUES ('safe')")
    currentAugmented.close()
    const currentAugmentedCtx = new Context()
    await currentAugmentedCtx.plugin(SessionStore)
    await currentAugmentedCtx.plugin(SessionProjectionRegistry)
    await expect(currentAugmentedCtx.plugin(SqliteSessionQueryEngine, {
      path: currentAugmentedPath,
      journalMode: 'delete',
    })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(currentAugmentedCtx.sessionQuery).toBeUndefined()
    const stillCurrentAugmented = new DatabaseSync(currentAugmentedPath)
    expect(stillCurrentAugmented.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'safe' })
    expect(stillCurrentAugmented.prepare('PRAGMA user_version').get())
      .toEqual({ user_version: SESSION_QUERY_SQLITE_SCHEMA_VERSION })
    expect(stillCurrentAugmented.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillCurrentAugmented.close()

    const foreignPath = await temporaryPath('foreign.db')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('PRAGMA journal_mode = WAL')
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.exec("INSERT INTO canonical VALUES ('safe')")
    foreign.close()
    const foreignCtx = new Context()
    await foreignCtx.plugin(SessionStore)
    await foreignCtx.plugin(SessionProjectionRegistry)
    await expect(foreignCtx.plugin(SqliteSessionQueryEngine, { path: foreignPath, journalMode: 'delete' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(foreignCtx.sessionQuery).toBeUndefined()
    const stillForeign = new DatabaseSync(foreignPath)
    expect(stillForeign.prepare('SELECT value FROM canonical').get()).toEqual({ value: 'safe' })
    expect(stillForeign.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillForeign.close()

    const wildcardPath = await temporaryPath('sqlite-wildcard.db')
    const wildcard = new DatabaseSync(wildcardPath)
    wildcard.exec('PRAGMA journal_mode = WAL')
    wildcard.exec('CREATE TABLE sqliteX(value TEXT)')
    wildcard.exec("INSERT INTO sqliteX VALUES ('safe')")
    wildcard.close()
    const wildcardCtx = new Context()
    await wildcardCtx.plugin(SessionStore)
    await wildcardCtx.plugin(SessionProjectionRegistry)
    await expect(wildcardCtx.plugin(SqliteSessionQueryEngine, {
      path: wildcardPath,
      journalMode: 'delete',
    })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(wildcardCtx.sessionQuery).toBeUndefined()
    const stillWildcard = new DatabaseSync(wildcardPath)
    expect(stillWildcard.prepare('SELECT value FROM sqliteX').get()).toEqual({ value: 'safe' })
    expect(stillWildcard.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
    expect(stillWildcard.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(stillWildcard.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillWildcard.close()

    const otherAppPath = await temporaryPath('other-app.db')
    const otherApp = new DatabaseSync(otherAppPath)
    otherApp.exec('PRAGMA application_id = 123')
    otherApp.close()
    const otherAppCtx = new Context()
    await otherAppCtx.plugin(SessionStore)
    await otherAppCtx.plugin(SessionProjectionRegistry)
    await expect(otherAppCtx.plugin(SqliteSessionQueryEngine, { path: otherAppPath }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(otherAppCtx.sessionQuery).toBeUndefined()
  })

  it('fails plugin initialization without an unhandled rejection or partial service', async () => {
    const path = await temporaryPath('never-queried.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await expect(ctx.plugin(SqliteSessionQueryEngine, { path }))
        .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
      expect(ctx.sessionQuery).toBeUndefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('defers an invalid database failure only in first-search mode', async () => {
    const path = await temporaryPath('lazy-invalid.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()

    const lazyCtx = new Context()
    await lazyCtx.plugin(SessionStore)
    await lazyCtx.plugin(SessionProjectionRegistry)
    const lazy = await lazyCtx.plugin(SqliteSessionQueryEngine, {
      path,
      openAt: 'first-search',
    })
    expect(lazyCtx.sessionQuery).toBeInstanceOf(SqliteSessionQueryEngine)
    await expect(lazyCtx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await lazy.dispose()

    const eagerCtx = new Context()
    await eagerCtx.plugin(SessionStore)
    await eagerCtx.plugin(SessionProjectionRegistry)
    await expect(eagerCtx.plugin(SqliteSessionQueryEngine, { path }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(eagerCtx.sessionQuery).toBeUndefined()
  })

  it.each(['sessions', 'events'] as const)(
    'forwards one exact reconciliation signal through both snapshot lists and persisted inspection for %s search',
    async (scope) => {
      const durable = header(`signal-${scope}`)
      TestPersistence.reset([{ meta: durable, events: messageEvents('signal needle') }])
      const ctx = await liveContext()
      await ctx.plugin(TestPersistence)
      const controller = new AbortController()

      const result = scope === 'sessions'
        ? await ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
        : await ctx.sessionQuery.searchEvents(
          { sessionId: durable.id, query: 'needle' },
          { signal: controller.signal },
        )

      expect(result.items).toHaveLength(1)
      expect(TestPersistence.listSignals).toEqual([controller.signal, controller.signal])
      expect(TestPersistence.readSignals).toEqual([controller.signal])
    },
  )

  it.each(['sessions', 'events'] as const)(
    'starts no persistence observation for a pre-aborted %s search',
    async (scope) => {
      const durable = header(`pre-aborted-${scope}`)
      TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
      const ctx = await liveContext()
      await ctx.plugin(TestPersistence)
      const controller = new AbortController()
      controller.abort(new Error(`pre-aborted ${scope}`))

      const pending = scope === 'sessions'
        ? ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
        : ctx.sessionQuery.searchEvents(
          { sessionId: durable.id, query: 'needle' },
          { signal: controller.signal },
        )

      await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
      expect(TestPersistence.listSignals).toEqual([])
      expect(TestPersistence.readSignals).toEqual([])
    },
  )

  it('awaits cooperative snapshot-list cancellation cleanup without starting another observation step', async () => {
    const durable = header('cooperative-list-abort')
    TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const started = Promise.withResolvers<AbortSignal>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    TestPersistence.listEffect = async (signal) => {
      TestPersistence.listEffect = undefined
      if (signal === undefined) throw new Error('expected reconciliation signal')
      started.resolve(signal)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      abortObserved.resolve(undefined)
      await cleanup.promise
      signal.throwIfAborted()
    }
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    expect(await started.promise).toBe(controller.signal)
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(new Error('cooperative list cancellation'))
    await abortObserved.promise
    expect(settled).toBe(false)
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.readSignals).toEqual([])

    cleanup.resolve(undefined)
    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
  })

  it('keeps a second search serialized while an abort-ignoring snapshot list finishes', async () => {
    const durable = header('serialized-list-abort')
    TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const cleanup = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    TestPersistence.listGate = cleanup.promise
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      started.resolve(undefined)
    }
    const controller = new AbortController()
    const first = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    await started.promise
    let firstSettled = false
    let secondSettled = false
    void first.then(
      () => { firstSettled = true },
      () => { firstSettled = true },
    )
    controller.abort(new Error('ignored list cancellation'))
    const second = ctx.sessionQuery.searchEvents({ sessionId: durable.id, query: 'needle' })
    void second.then(
      () => { secondSettled = true },
      () => { secondSettled = true },
    )
    await Promise.resolve()

    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.readSignals).toEqual([])

    cleanup.resolve(undefined)
    await expect(first).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    await expect(second).resolves.toMatchObject({ items: [{ sessionId: durable.id }] })
  })

  it('awaits an abort-ignoring inspection and starts neither another inspection nor the after-list', async () => {
    const first = header('ignored-inspect-first')
    const second = header('ignored-inspect-second')
    TestPersistence.reset([
      { meta: first, events: messageEvents('first needle') },
      { meta: second, events: messageEvents('second needle') },
    ])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const started = Promise.withResolvers<AbortSignal>()
    const cleanup = Promise.withResolvers<undefined>()
    TestPersistence.readEffect = async (_entry, signal) => {
      TestPersistence.readEffect = undefined
      if (signal === undefined) throw new Error('expected reconciliation signal')
      started.resolve(signal)
      await cleanup.promise
    }
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    expect(await started.promise).toBe(controller.signal)
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(new Error('ignored inspect cancellation'))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.reads.get(first.id)).toBe(1)
    expect(TestPersistence.reads.get(second.id)).toBeUndefined()

    cleanup.resolve(undefined)
    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.reads.get(second.id)).toBeUndefined()
  })

  it('cancels both queued and in-flight source waits without committing them', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    const boundaryController = new AbortController()
    const boundary = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: boundaryController.signal })
    queueMicrotask(() => { boundaryController.abort() })
    await expect(boundary).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    const readyController = new AbortController()
    readyController.abort()
    const internals = ctx.sessionQuery as unknown as {
      _ensureReady(signal: AbortSignal): Promise<void>
    }
    await expect(internals._ensureReady(readyController.signal))
      .rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    let releaseBlocking!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { releaseBlocking = resolve })
    let markBlockingStarted!: () => void
    const blockingStarted = new Promise<void>((resolve) => { markBlockingStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markBlockingStarted()
    }
    const blocking = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await blockingStarted

    const queuedController = new AbortController()
    const queued = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: queuedController.signal })
    queuedController.abort()
    await expect(queued).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    releaseBlocking()
    await expect(blocking).resolves.toEqual({ items: [] })

    TestPersistence.set({
      meta: header('uncommitted'),
      events: messageEvents('durable needle'),
    })
    let releaseActive!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { releaseActive = resolve })
    let markActiveStarted!: () => void
    const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markActiveStarted()
    }
    const activeController = new AbortController()
    const active = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: activeController.signal })
    await activeStarted
    activeController.abort()
    let activeSettled = false
    void active.then(
      () => { activeSettled = true },
      () => { activeSettled = true },
    )
    await Promise.resolve()
    expect(activeSettled).toBe(false)
    releaseActive()
    await expect(active).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    const db = (ctx.sessionQuery as unknown as { _db: DatabaseSync })._db
    expect(db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions').get()).toEqual({ count: 0 })
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('uncommitted') } }] })
  })

  it.each([
    [new Error('ready error'), 'ready error'],
    ['non-error ready failure', 'session-search dependency rejected with a non-Error value'],
  ])('normalizes a rejected readiness wait before mapping it to an index error', async (failure, detail) => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const internals = ctx.sessionQuery as unknown as {
      _ready: Promise<void>
      _ensureReady(signal: AbortSignal): Promise<void>
    }
    internals._ready = Promise.resolve().then(() => {
      throw failure
    })

    await expect(internals._ensureReady(new AbortController().signal))
      .rejects.toThrow(`session-search SQLite index failed to open: ${detail}`)
  })

  it('checks cancellation after readiness before reconciliation accesses SQLite', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const internals = ctx.sessionQuery as unknown as {
      _db: DatabaseSync
      _ready: Promise<void>
      _ensureReady(signal: AbortSignal | undefined): Promise<void>
    }
    const readiness = Promise.withResolvers<undefined>()
    internals._ready = readiness.promise
    const readyWaitStarted = Promise.withResolvers<undefined>()
    const ensureReady = internals._ensureReady.bind(internals)
    vi.spyOn(internals, '_ensureReady').mockImplementation(async (signal) => {
      const pending = ensureReady(signal)
      readyWaitStarted.resolve(undefined)
      return pending
    })
    const prepare = vi.spyOn(internals._db, 'prepare')
    const reason = new Error('cancelled after readiness')
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    await readyWaitStarted.promise

    const queueBoundaryAbort = readiness.promise.then(() => {
      queueMicrotask(() => { controller.abort(reason) })
    })
    readiness.resolve(undefined)
    await queueBoundaryAbort

    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects queued and future work when close waits for an accepted operation', async () => {
    TestPersistence.reset()
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const search = ctx.sessionQuery as SqliteSessionQueryEngine
    const accepted = search.searchSessions({ query: 'needle' })
    await started
    const queued = search.searchSessions({ query: 'needle' })
    const closing = search.close()
    const repeatedClose = search.close()
    expect(repeatedClose).toBe(closing)
    release()

    await expect(accepted).resolves.toEqual({ items: [] })
    await expect(queued).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await Promise.all([closing, repeatedClose])
    await expect(search.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(search.close()).toBe(closing)
  })

  it('awaits optional-persistence child-fiber quiescence on disposal', async () => {
    TestPersistence.reset()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    const persistence = await ctx.plugin(TestPersistence)
    const optional = (ctx.sessionQuery as unknown as {
      _optionalPersistenceFiber: Fiber
    })._optionalPersistenceFiber
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => { release = resolve })
    optional.ctx.effect(() => () => cleanup)

    let settled = false
    const disposing = search.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await disposing
    await persistence.dispose()
  })

  it('combines the real JSONL persistence backend with the real search service keylessly', async () => {
    const persistenceRoot = await temporaryPath('sessions')
    const searchPath = await temporaryPath('derived.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path: searchPath })
    const meta = header('real', 10, { cwd: '/work' })
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append(messageEvents('real JSONL needle'))
    await writer.close()

    await expect(ctx.sessionQuery.searchSessions({ query: 'JSONL needle' }))
      .resolves.toMatchObject({ items: [{ header: meta, persisted: true, live: false }] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: meta.id, query: 'JSONL needle' }))
      .resolves.toMatchObject({ session: meta, items: [{ sessionId: meta.id, seq: SessionSeq(0) }] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await search.dispose()
    const reader = await ctx.sessionPersistence.open(meta.id, 'read')
    expect(reader.header).toMatchObject(meta)
    await expect(reader.read()).resolves.toMatchObject({ events: [{ seq: SessionSeq(0) }] })
    await reader.close()
    await persistence.dispose()
  })

  it('reconciles a reopened derived index: unchanged revisions skip reads, another store reloads', async () => {
    const persistenceRootA = await temporaryPath('sessions-a')
    const persistenceRootB = await temporaryPath('sessions-b')
    const searchPath = await temporaryPath('derived-collision.db')
    const shared = header('same-id', 10)
    const storeSession = async (ctx: Context, events: SessionEvent[]): Promise<void> => {
      const writer = await ctx.sessionPersistence.create(shared)
      await writer.append(events)
      await writer.close()
    }

    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const persistenceA = await first.plugin(JsonlSessionPersistence, { root: persistenceRootA, compression: 'none' })
    await storeSession(first, messageEvents('alpha source'))
    const openA = vi.spyOn(first.sessionPersistence, 'open')
    const searchA = await first.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(first.sessionQuery.searchSessions({ query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(openA).toHaveBeenCalledTimes(1)
    await searchA.dispose()
    await persistenceA.dispose()

    const reopened = new Context()
    await reopened.plugin(SessionStore)
    await reopened.plugin(SessionProjectionRegistry)
    const persistenceAAgain = await reopened.plugin(JsonlSessionPersistence, { root: persistenceRootA, compression: 'none' })
    const reopenedOpen = vi.spyOn(reopened.sessionPersistence, 'open')
    const searchAAgain = await reopened.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(reopened.sessionQuery.searchSessions({ query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(reopenedOpen).not.toHaveBeenCalled()
    await searchAAgain.dispose()
    await persistenceAAgain.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const persistenceB = await second.plugin(JsonlSessionPersistence, { root: persistenceRootB, compression: 'none' })
    await storeSession(second, messageEvents('bravo source'))
    const openB = vi.spyOn(second.sessionPersistence, 'open')
    const searchB = await second.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(second.sessionQuery.searchSessions({ query: 'bravo' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    await expect(second.sessionQuery.searchSessions({ query: 'alpha' })).resolves.toEqual({ items: [] })
    expect(openB).toHaveBeenCalledTimes(1)
    await searchB.dispose()
    await persistenceB.dispose()
  })
})

/**
 * Await coalesced background synchronization through the engine's own
 * quiescence barrier, bounded so a lost wakeup fails loudly.
 * @param service - engine whose owned background job is observed.
 * @returns nothing once the job is quiescent.
 */
async function awaitBackgroundSync(service: SqliteSessionQueryEngine): Promise<void> {
  await service.whenSynchronized()
}

/** Background-mode configuration with a quiet periodic timer for deterministic scans. */
const BACKGROUND_SYNC = {
  path: ':memory:',
  syncMode: 'background',
  syncIntervalMs: 60_000,
} as const

describe('SQLite background synchronization', () => {
  it('exposes background defaults and validates its sync configuration', async () => {
    const defaults = new SqliteSessionQueryEngine.Config({ path: ':memory:' })
    expect(defaults).toMatchObject({
      syncMode: 'on-search',
      syncIntervalMs: 5000,
      syncReadConcurrency: 2,
      syncBatchSessions: 24,
    })
    expect(new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      syncMode: 'background',
      syncIntervalMs: 1_000,
      syncReadConcurrency: 3,
    })).toMatchObject({ syncMode: 'background', syncIntervalMs: 1_000, syncReadConcurrency: 3 })

    expect(() => new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      syncMode: 'later' as never,
    })).toThrow()
    for (const syncIntervalMs of [0, -1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      expect(() => new SqliteSessionQueryEngine.Config({ path: ':memory:', syncIntervalMs })).toThrow()
    }
    for (const syncReadConcurrency of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SqliteSessionQueryEngine.Config({ path: ':memory:', syncReadConcurrency })).toThrow()
    }
    for (const syncBatchSessions of [0, -1, 1.5, 10_001]) {
      expect(() => new SqliteSessionQueryEngine.Config({ path: ':memory:', syncBatchSessions })).toThrow()
    }

    const ctx = await liveContext(BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    expect(service.config).toMatchObject({
      syncMode: 'background',
      syncIntervalMs: 60_000,
      syncReadConcurrency: 2,
    })
    await service.close()
  })

  it('skips unchanged live histories and observes appends and replacement instances', async () => {
    const ctx = await liveContext(BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    try {
      const meta = header('live-revision', 1)
      const live = ctx.sessions.prepare(meta.id, { meta, seed: messageEvents('original needle') })
      const detach = ctx.sessions.enter(live)
      ctx.sessions.announce(live)
      const snapshot = vi.spyOn(live, 'snapshotEvents')
      expect((await service.searchSessions({ query: 'original' })).items).toHaveLength(1)
      expect(snapshot).toHaveBeenCalledTimes(1)
      expect((await service.searchSessions({ query: 'original' })).items).toHaveLength(1)
      expect(snapshot).toHaveBeenCalledTimes(1)

      live.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'appended needle' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect((await service.searchSessions({ query: 'appended' })).items).toHaveLength(1)
      expect(snapshot).toHaveBeenCalledTimes(2)
      detach()

      const replacement = ctx.sessions.prepare(meta.id, { meta, seed: messageEvents('replacement needle') })
      const detachReplacement = ctx.sessions.enter(replacement)
      ctx.sessions.announce(replacement)
      replacement.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'second replacement' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(replacement.seq).toBe(live.seq)
      expect((await service.searchSessions({ query: 'replacement' })).items).toHaveLength(1)
      expect((await service.searchSessions({ query: 'original' })).items).toEqual([])
      detachReplacement()
      expect((await service.searchSessions({ query: 'replacement' })).items).toEqual([])
    } finally {
      await service.close()
    }
  })

  it('keeps existing live FTS rows when a session appends an event', async () => {
    const ctx = await liveContext(BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    try {
      const live = ctx.sessions.create(SessionId('live-append-delta'), { seed: messageEvents('original needle') })
      await service.searchEvents({ sessionId: live.id, query: 'original' })
      const db = Reflect.get(service, '_db') as DatabaseSync
      const prepare = vi.spyOn(db, 'prepare')
      live.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'appended needle' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect((await service.searchEvents({ sessionId: live.id, query: 'appended' })).items).toHaveLength(1)
      expect(prepare.mock.calls.map(([sql]) => sql)).not.toContain('DELETE FROM temp.live_docs WHERE session_id = ?')
      expect((await service.searchEvents({ sessionId: live.id, query: 'original' })).items).toHaveLength(1)
      live.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'replacement needle' }], source: { kind: 'test' },
      }), {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
        sourceEventSeqs: [SessionSeq(0)],
      })
      expect((await service.searchEvents({ sessionId: live.id, query: 'original' })).items)
        .toMatchObject([{ seq: SessionSeq(0), surface: 'shadowed' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('counts searchable live-only sessions inside the requested coverage scope', async () => {
    const ctx = await liveContext(BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    try {
      const visible = ctx.sessions.create(SessionId('live-counted'), { meta: header('live-counted', 1, { cwd: '/visible' }) })
      visible.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'counted needle' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const hidden = ctx.sessions.create(SessionId('live-other-scope'), { meta: header('live-other-scope', 1, { cwd: '/other' }) })
      hidden.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hidden needle' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await awaitBackgroundSync(service)
      const result = await service.searchSessions({
        query: 'needle',
        sessionFilters: [{ kind: 'cwd', values: ['/visible'] }, { kind: 'availability', values: ['live'] }],
      })
      expect(result.items.map(item => item.header.id)).toEqual([visible.id])
      expect(result.coverage).toMatchObject({ indexedSessions: 1, pendingSessions: 0, failedSessions: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('commits pending sessions in bounded batches and keeps every one searchable', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      meta: header(`batched-${index}`, index + 1),
      events: messageEvents(`batched needle ${index}`),
    }))
    TestPersistence.reset(entries)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { ...BACKGROUND_SYNC, syncBatchSessions: 5 })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)

    const page = await service.searchSessions({ query: 'needle', limit: 50 })
    expect(page.items).toHaveLength(12)
    expect(new Set(page.items.map(item => item.header.id)).size).toBe(12)
    expect(page.coverage).toMatchObject({ state: 'ready', indexedSessions: 12, pendingSessions: 0 })
    await search.dispose()
    await persistence.dispose()
  })

  it('returns indexed history without awaiting a blocked persistence listing', async () => {
    const durable = header('blocked-listing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('blocked needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    const persistence = await ctx.plugin(TestPersistence)

    const pending = await service.searchSessions({ query: 'blocked' })
    expect(pending.items).toEqual([])
    expect(pending.coverage).toMatchObject({
      state: 'initializing',
    })
    expect(pending.coverage).not.toHaveProperty('pendingSessions')
    expect(pending.coverage).not.toHaveProperty('failedSessions')
    await listed.promise

    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    const page = await service.searchSessions({ query: 'blocked' })
    expect(page.items).toMatchObject([{ header: durable, live: false, persisted: true }])
    expect(page.coverage).toMatchObject({
      state: 'ready',
      indexedSessions: 1,
      pendingSessions: 0,
      failedSessions: 0,
    })
    expect(typeof page.coverage?.checkedAt).toBe('number')
    expect(TestPersistence.reads.get(durable.id)).toBe(1)
    await search.dispose()
    await persistence.dispose()
  })

  it('hides a known-changed generation until its replacement commits', async () => {
    const durable = header('known-changed')
    TestPersistence.reset([{ meta: durable, events: messageEvents('original needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'original' })).items)
      .toMatchObject([{ header: durable, persisted: true }])

    TestPersistence.set({ meta: durable, events: messageEvents('replacement needle') })
    const readGate = Promise.withResolvers<undefined>()
    const readStarted = Promise.withResolvers<undefined>()
    TestPersistence.readEffect = async () => {
      readStarted.resolve(undefined)
      await readGate.promise
    }
    await service.searchSessions({ query: 'original' })
    await readStarted.promise

    const hidden = await service.searchSessions({ query: 'original' })
    expect(hidden.items).toEqual([])
    expect(hidden.coverage).toMatchObject({
      state: 'syncing',
      indexedSessions: 0,
      pendingSessions: 1,
      failedSessions: 0,
    })
    expect((await service.searchSessions({ query: 'replacement' })).items).toEqual([])

    readGate.resolve(undefined)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'replacement' })).items)
      .toMatchObject([{ header: durable, persisted: true }])
    expect((await service.searchSessions({ query: 'original' })).items).toEqual([])
    await search.dispose()
    await persistence.dispose()
  })

  it('backs off repeated failures without hiding degraded coverage and retries a new revision immediately', async () => {
    const durable = header('retry-backoff')
    TestPersistence.reset([{ meta: durable, events: messageEvents('retry needle') }])
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    TestPersistence.readFailures.add(durable.id)
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    await service.searchSessions({ query: 'retry' })
    await awaitBackgroundSync(service)
    const reads = TestPersistence.reads.get(durable.id)
    await service.searchSessions({ query: 'retry' })
    await awaitBackgroundSync(service)
    expect(TestPersistence.reads.get(durable.id)).toBe(reads)
    expect((await service.searchSessions({ query: 'retry' })).coverage).toMatchObject({ state: 'degraded', failedSessions: 1 })
    TestPersistence.readFailures.delete(durable.id)
    TestPersistence.set({ meta: durable, events: messageEvents('new revision needle') })
    await service.searchSessions({ query: 'retry' })
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'revision' })).coverage).toMatchObject({ state: 'ready', failedSessions: 0 })
    now.mockRestore()
    await search.dispose()
    await persistence.dispose()
  })

  it('retries transient failures after the bounded delay across reopening', async () => {
    const durable = header('retry-reopen')
    TestPersistence.reset([{ meta: durable, events: messageEvents('eventual needle') }])
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const path = await temporaryPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    let search = await ctx.plugin(SqliteSessionQueryEngine, { ...BACKGROUND_SYNC, path })
    let service = ctx.sessionQuery as SqliteSessionQueryEngine
    TestPersistence.readFailures.add(durable.id)
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    await service.searchSessions({ query: 'eventual' })
    await awaitBackgroundSync(service)
    const reads = TestPersistence.reads.get(durable.id)
    await search.dispose()
    TestPersistence.readFailures.delete(durable.id)
    search = await ctx.plugin(SqliteSessionQueryEngine, { ...BACKGROUND_SYNC, path })
    service = ctx.sessionQuery as SqliteSessionQueryEngine
    await awaitBackgroundSync(service)
    expect(TestPersistence.reads.get(durable.id)).toBe(reads)
    expect((await service.searchSessions({ query: 'eventual' })).coverage).toMatchObject({ state: 'degraded', failedSessions: 1 })
    now.mockReturnValue(1_005_001)
    await service.searchSessions({ query: 'eventual' })
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'eventual' })).coverage).toMatchObject({ state: 'ready', failedSessions: 0 })
    now.mockRestore()
    await search.dispose()
    await persistence.dispose()
  })

  it('does not carry a failed retry delay to a replacement source with the same revision', async () => {
    const durable = header('retry-source-switch')
    TestPersistence.reset([{ meta: durable, events: messageEvents('replacement needle') }])
    const revision = TestPersistence.revisions.get(durable.id)!
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    TestPersistence.readFailures.add(durable.id)
    const first = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    await service.searchSessions({ query: 'replacement' })
    await awaitBackgroundSync(service)
    await first.dispose()
    await awaitBackgroundSync(service)
    TestPersistence.readFailures.delete(durable.id)
    TestPersistence.revisions.set(durable.id, revision)
    const second = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    const result = await service.searchSessions({ query: 'replacement' })
    expect(result.items).toMatchObject([{ header: durable }])
    expect(result.coverage).toMatchObject({ state: 'ready', failedSessions: 0 })
    now.mockRestore()
    await search.dispose()
    await second.dispose()
  })

  it('counts detached live sources as pending within session filters while listing is blocked', async () => {
    const durable = header('detached-coverage', 10, { cwd: '/detached' })
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const live = ctx.sessions.prepare(durable.id, {
      seed: messageEvents('live needle'), meta: { createdAt: durable.createdAt, cwd: '/detached' },
    })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'live' })).coverage)
      .toMatchObject({ state: 'ready', indexedSessions: 1, pendingSessions: 0 })
    await awaitBackgroundSync(service)
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    detach()
    const result = await service.searchSessions({ query: 'durable', sessionFilters: [{ kind: 'id', values: [durable.id] }] })
    await listed.promise
    expect(result.items).toEqual([])
    expect(result.coverage).toMatchObject({ state: 'syncing', indexedSessions: 0, pendingSessions: 1 })
    const other = await service.searchSessions({ query: 'durable', sessionFilters: [{ kind: 'id', values: [SessionId('other')] }] })
    expect(other.coverage).toMatchObject({ state: 'ready', pendingSessions: 0 })
    const event = await service.searchEvents({ sessionId: durable.id, query: 'durable' })
    expect(event.coverage).toMatchObject({ state: 'syncing', pendingSessions: 1 })
    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'durable' })).coverage)
      .toMatchObject({ state: 'ready', indexedSessions: 1, pendingSessions: 0 })
    await search.dispose()
    await persistence.dispose()
  })

  it('reports ready while an unchanged background listing is blocked', async () => {
    const durable = header('idle-listing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('idle needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    await service.searchSessions({ query: 'idle' })
    await listed.promise
    expect((await service.searchSessions({ query: 'idle' })).coverage).toMatchObject({ state: 'ready', pendingSessions: 0 })
    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    await search.dispose()
    await persistence.dispose()
  })

  it('isolates a failing source read and keeps other committed sessions searchable', async () => {
    const healthy = header('healthy-source')
    const broken = header('broken-source')
    TestPersistence.reset([
      { meta: healthy, events: messageEvents('healthy needle') },
      { meta: broken, events: messageEvents('broken needle') },
    ])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    TestPersistence.readFailures.add(broken.id)
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)

    const page = await service.searchSessions({ query: 'healthy' })
    expect(page.items).toMatchObject([{ header: healthy, persisted: true }])
    expect(page.coverage).toMatchObject({
      state: 'degraded',
      indexedSessions: 1,
      pendingSessions: 0,
      failedSessions: 1,
    })
    const scoped = await service.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: [broken.id] }],
    })
    expect(scoped.items).toEqual([])
    expect(scoped.coverage).toMatchObject({
      indexedSessions: 0,
      pendingSessions: 0,
      failedSessions: 1,
    })

    TestPersistence.readFailures.delete(broken.id)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    await service.searchSessions({ query: 'broken' })
    await awaitBackgroundSync(service)
    const recovered = await service.searchSessions({ query: 'broken' })
    expect(recovered.items).toMatchObject([{ header: broken, persisted: true }])
    expect(recovered.coverage).toMatchObject({ state: 'ready', indexedSessions: 2, failedSessions: 0 })
    now.mockRestore()
    await search.dispose()
    await persistence.dispose()
  })

  it('resets source failure backoff when a new revision appears', async () => {
    const durable = header('revision-backoff')
    TestPersistence.reset([{ meta: durable, events: messageEvents('revision needle') }])
    TestPersistence.readFailures.add(durable.id)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    const db = (service as unknown as { _db: DatabaseSync })._db
    await awaitBackgroundSync(service)
    db.prepare("UPDATE sync_sessions SET attempts = 2, error = 'old revision failure' WHERE id = ?").run(durable.id)

    TestPersistence.set({ meta: durable, events: messageEvents('revision replacement') })
    await service.searchSessions({ query: 'replacement' })
    await awaitBackgroundSync(service)
    expect(db.prepare('SELECT attempts FROM sync_sessions WHERE id = ?').get(durable.id)).toEqual({ attempts: 1 })

    await search.dispose()
    await persistence.dispose()
  })

  it('deletes indexed rows only after a complete successful listing', async () => {
    const durable = header('complete-listing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('complete needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    const indexed = await service.searchSessions({ query: 'complete' })
    expect(indexed.items).toMatchObject([{ header: durable }])
    const checkedAt = indexed.coverage?.checkedAt
    expect(typeof checkedAt).toBe('number')

    TestPersistence.failure = new Error('listing offline')
    await service.searchSessions({ query: 'complete' })
    await awaitBackgroundSync(service)
    const offline = await service.searchSessions({ query: 'complete' })
    expect(offline.items).toMatchObject([{ header: durable }])
    expect(offline.coverage).toMatchObject({ state: 'degraded', indexedSessions: 1, checkedAt })

    TestPersistence.failure = undefined
    TestPersistence.entries.delete(durable.id)
    await service.searchSessions({ query: 'complete' })
    await awaitBackgroundSync(service)
    const removed = await service.searchSessions({ query: 'complete' })
    expect(removed.items).toEqual([])
    expect(removed.coverage).toMatchObject({ state: 'ready', indexedSessions: 0 })
    await search.dispose()
    await persistence.dispose()
  })

  it('does not let a caller abort cancel the shared synchronization', async () => {
    const durable = header('caller-abort')
    TestPersistence.reset([{ meta: durable, events: messageEvents('caller abort needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    const persistence = await ctx.plugin(TestPersistence)
    await listed.promise

    const controller = new AbortController()
    controller.abort()
    await expect(service.searchSessions({ query: 'caller' }, { signal: controller.signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    expect(TestPersistence.listSignals.length).toBeGreaterThan(0)
    for (const signal of TestPersistence.listSignals) expect(signal?.aborted).toBe(false)

    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'caller' })).items)
      .toMatchObject([{ header: durable, persisted: true }])
    await search.dispose()
    await persistence.dispose()
  })

  it('cancels and awaits owned background work on disposal', async () => {
    const durable = header('disposed-work')
    TestPersistence.reset([{ meta: durable, events: messageEvents('disposed needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const readStarted = Promise.withResolvers<undefined>()
    TestPersistence.readEffect = async (_entry, signal) => {
      readStarted.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    }
    const persistence = await ctx.plugin(TestPersistence)
    await readStarted.promise

    let settled = false
    const disposing = search.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await disposing
    expect(settled).toBe(true)
    expect(TestPersistence.readSignals.at(-1)?.aborted).toBe(true)
    await expect(service.searchSessions({ query: 'disposed' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await persistence.dispose()
  })

  it('scopes coverage counts to the request session predicates', async () => {
    const alpha = header('scoped-alpha', 10, { cwd: '/alpha' })
    const beta = header('scoped-beta', 20, { cwd: '/beta' })
    TestPersistence.reset([
      { meta: alpha, events: messageEvents('scoped needle') },
      { meta: beta, events: messageEvents('scoped needle') },
    ])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const gate = Promise.withResolvers<undefined>()
    const bothReads = Promise.withResolvers<undefined>()
    let started = 0
    TestPersistence.readEffect = async () => {
      started += 1
      if (started === 2) bothReads.resolve(undefined)
      await gate.promise
    }
    const persistence = await ctx.plugin(TestPersistence)
    await bothReads.promise

    const all = await service.searchSessions({ query: 'scoped' })
    expect(all.items).toEqual([])
    expect(all.coverage).toMatchObject({ state: 'syncing', indexedSessions: 0, pendingSessions: 2 })
    const alphaOnly = await service.searchSessions({
      query: 'scoped',
      sessionFilters: [{ kind: 'cwd', values: ['/alpha'] }],
    })
    expect(alphaOnly.coverage).toMatchObject({ indexedSessions: 0, pendingSessions: 1, failedSessions: 0 })
    expect(Object.keys(alphaOnly.coverage ?? {}).sort())
      .toEqual(['checkedAt', 'failedSessions', 'indexedSessions', 'pendingSessions', 'state'])
    expect(JSON.stringify(alphaOnly.coverage)).not.toContain('/beta')
    const betaOnly = await service.searchSessions({
      query: 'scoped',
      sessionFilters: [{ kind: 'id', values: [beta.id] }],
    })
    expect(betaOnly.coverage).toMatchObject({ pendingSessions: 1 })

    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    const scopedAfter = await service.searchSessions({
      query: 'scoped',
      sessionFilters: [{ kind: 'cwd', values: ['/alpha'] }],
    })
    expect(scopedAfter.items).toMatchObject([{ header: alpha }])
    expect(scopedAfter.coverage).toMatchObject({ state: 'ready', indexedSessions: 1, pendingSessions: 0 })
    await search.dispose()
    await persistence.dispose()
  })

  it('distinguishes a known pending event target from an unknown session', async () => {
    const target = header('pending-target', 10)
    TestPersistence.reset([{ meta: target, events: messageEvents('pending needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const gate = Promise.withResolvers<undefined>()
    const readStarted = Promise.withResolvers<undefined>()
    TestPersistence.readEffect = async () => {
      readStarted.resolve(undefined)
      await gate.promise
    }
    const persistence = await ctx.plugin(TestPersistence)
    await readStarted.promise

    const pending = await service.searchEvents({ sessionId: target.id, query: 'pending' })
    expect(pending.items).toEqual([])
    expect(pending.session).toEqual(target)
    expect(pending.coverage).toMatchObject({
      state: 'syncing',
      indexedSessions: 0,
      pendingSessions: 1,
      failedSessions: 0,
    })
    await expect(service.searchEvents({ sessionId: SessionId('never-listed'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    const indexed = await service.searchEvents({ sessionId: target.id, query: 'pending' })
    expect(indexed.items).toMatchObject([{ sessionId: target.id, seq: SessionSeq(0) }])
    expect(indexed.coverage).toMatchObject({ state: 'ready', indexedSessions: 1, pendingSessions: 0 })
    await search.dispose()
    await persistence.dispose()
  })

  it('hides indexed content from a previous persistence source immediately', async () => {
    const previous = header('previous-source', 10)
    TestPersistence.reset([{ meta: previous, events: messageEvents('previous source needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const firstPersistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'previous' })).items).toMatchObject([{ header: previous }])

    await firstPersistence.dispose()
    await awaitBackgroundSync(service)
    const replacement = header('replacement-source', 20)
    TestPersistence.reset([{ meta: replacement, events: messageEvents('replacement source needle') }])
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    const secondPersistence = await ctx.plugin(TestPersistence)

    const hidden = await service.searchSessions({ query: 'previous' })
    expect(hidden.items).toEqual([])
    expect(hidden.coverage).toEqual({ state: 'initializing' })
    await expect(service.searchEvents({ sessionId: previous.id, query: 'previous' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await listed.promise

    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'replacement' })).items)
      .toMatchObject([{ header: replacement }])
    await search.dispose()
    await secondPersistence.dispose()
  })

  it('withholds a reopened index until the current source metadata verifies', async () => {
    const path = await temporaryPath('reopened-verification.db')
    const previous = header('previous-store', 10)
    TestPersistence.reset([{ meta: previous, events: messageEvents('previous store needle') }])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const firstPersistence = await first.plugin(TestPersistence)
    const firstSearch = await first.plugin(SqliteSessionQueryEngine, { ...BACKGROUND_SYNC, path })
    await awaitBackgroundSync(first.sessionQuery as SqliteSessionQueryEngine)
    expect((await first.sessionQuery.searchSessions({ query: 'previous' })).items)
      .toMatchObject([{ header: previous }])
    await firstSearch.dispose()
    await firstPersistence.dispose()

    const replacement = header('replacement-store', 20)
    TestPersistence.reset([{ meta: replacement, events: messageEvents('replacement store needle') }])
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const secondPersistence = await second.plugin(TestPersistence)
    const secondSearch = await second.plugin(SqliteSessionQueryEngine, { ...BACKGROUND_SYNC, path })
    const service = second.sessionQuery as SqliteSessionQueryEngine

    const withheld = await service.searchSessions({ query: 'needle' })
    expect(withheld.items).toEqual([])
    expect(withheld.coverage).toMatchObject({
      state: 'initializing',
    })
    expect(withheld.coverage?.checkedAt).toBeUndefined()
    await expect(service.searchEvents({ sessionId: previous.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await listed.promise

    gate.resolve(undefined)
    await awaitBackgroundSync(service)
    const verified = await service.searchSessions({ query: 'needle' })
    expect(verified.items).toMatchObject([{ header: replacement }])
    expect(verified.coverage).toMatchObject({ state: 'ready', indexedSessions: 1 })
    await expect(service.searchEvents({ sessionId: previous.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await secondSearch.dispose()
    await secondPersistence.dispose()
  })

  it('reconciles periodically while active without a caller query', async () => {
    const early = header('periodic-early')
    TestPersistence.reset([{ meta: early, events: messageEvents('periodic needle') }])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, {
      path: ':memory:',
      syncMode: 'background',
      syncIntervalMs: 20,
    })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'periodic' })).items).toHaveLength(1)

    const late = header('periodic-late')
    const rescanned = Promise.withResolvers<undefined>()
    TestPersistence.set({ meta: late, events: messageEvents('late needle') })
    TestPersistence.listStarted = () => { rescanned.resolve(undefined) }
    await rescanned.promise
    await awaitBackgroundSync(service)
    expect((await service.searchSessions({ query: 'late' })).items).toMatchObject([{ header: late }])
    await search.dispose()
    await persistence.dispose()
  })

  it.each([false, true] as const)('invalidates captured pagination when persistence source changes (background=%s)', async (background) => {
    const previous = header(`snapshot-previous-${background}`)
    const previousOther = header(`snapshot-previous-other-${background}`, 2)
    TestPersistence.reset([
      { meta: previous, events: [
        ...messageEvents('previous snapshot needle'),
        { ...messageEvents('previous snapshot needle again', 2)[0]!, seq: SessionSeq(1) },
      ] },
      { meta: previousOther, events: messageEvents('previous snapshot needle other') },
    ])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, background ? BACKGROUND_SYNC : { path: ':memory:' })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const firstPersistence = await ctx.plugin(TestPersistence)
    if (background) await awaitBackgroundSync(service)

    const first = await service.searchSessions({ query: 'snapshot', limit: 1, snapshot: true })
    expect(first.nextCursor).toBeDefined()
    const firstEvents = await service.searchEvents({
      sessionId: previous.id,
      query: 'snapshot',
      limit: 1,
      snapshot: true,
    })
    expect(firstEvents.nextCursor).toBeDefined()

    await firstPersistence.dispose()
    const replacement = header(`snapshot-replacement-${background}`)
    TestPersistence.reset([{ meta: replacement, events: messageEvents('replacement snapshot needle') }])
    const secondPersistence = await ctx.plugin(TestPersistence)

    await expect(service.searchSessions({
      query: 'snapshot',
      limit: 1,
      snapshot: true,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
    await expect(service.searchEvents({
      sessionId: previous.id,
      query: 'snapshot',
      limit: 1,
      snapshot: true,
      ...(firstEvents.nextCursor === undefined ? {} : { cursor: firstEvents.nextCursor }),
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))

    await search.dispose()
    await secondPersistence.dispose()
  })

  it('keeps live shadowing, generations, and captured pagination in background mode', async () => {
    const shared = header('background-live', 10)
    const other = header('background-other', 20)
    TestPersistence.reset([
      { meta: shared, events: messageEvents('persisted needle') },
      { meta: other, events: messageEvents('other needle') },
    ])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, BACKGROUND_SYNC)
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const persistence = await ctx.plugin(TestPersistence)
    await awaitBackgroundSync(service)

    const first = await service.searchSessions({ query: 'needle', limit: 1, snapshot: true })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeDefined()
    expect(first.coverage?.state).toBe('ready')
    // A capture keeps its original ranking and coverage while the corpus changes.
    TestPersistence.set({ meta: header('background-new', 30), events: messageEvents('fresh needle') })
    await service.searchSessions({ query: 'needle' })
    await awaitBackgroundSync(service)
    const continuation = await service.searchSessions({
      query: 'needle',
      limit: 1,
      snapshot: true,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    })
    expect(continuation.items).toHaveLength(1)
    expect(continuation.coverage).toEqual(first.coverage)

    const generationPage = await service.searchSessions({ query: 'needle', limit: 1 })
    const generationCursor = generationPage.nextCursor
    expect(generationCursor).toBeDefined()
    TestPersistence.set({ meta: header('background-newer', 40), events: messageEvents('newer needle') })
    await service.searchSessions({ query: 'needle' })
    await awaitBackgroundSync(service)
    await expect(service.searchSessions({
      query: 'needle',
      limit: 1,
      ...(generationCursor === undefined ? {} : { cursor: generationCursor }),
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
    await awaitBackgroundSync(service)

    const live = ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: shared.createdAt },
    })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    expect((await service.searchSessions({ query: 'live' })).items)
      .toMatchObject([{ header: shared, live: true, persisted: true }])
    expect((await service.searchSessions({ query: 'persisted' })).items).toEqual([])
    detach()
    expect((await service.searchSessions({ query: 'persisted' })).items)
      .toMatchObject([{ header: shared, live: false, persisted: true }])
    await search.dispose()
    await persistence.dispose()
  })
})
