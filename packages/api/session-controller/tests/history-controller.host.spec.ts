import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import ProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryController } from '../src/history/controller.ts'
import { WebController } from '../src/web/controller.ts'
import { installSessionReadTestServices } from './test-remote.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const roots: Context[] = []
const aborters: AbortController[] = []
afterEach(async () => {
  for (const abort of aborters.splice(0)) abort.abort()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})
async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await installSessionReadTestServices(ctx)
  const history = new HistoryController(ctx)
  const web = new WebController(ctx, history, (observation) => { observation[Symbol.dispose]() })
  const session = ctx.sessions.create(brandString<SessionId>('history-target'), { meta: { cwd: '/history-test' } })
  const abort = new AbortController()
  aborters.push(abort)
  const address = { kind: 'session' as const, sessionId: session.id }
  return { ctx, history, web, session, abort, address }
}

describe('HistoryController passive reads', () => {
  it('indexes a never-opened JSONL session without activation and refuses it after the log advances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-opening-test-'))
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, 'storage') })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await installSessionReadTestServices(ctx)
      await ctx.sessionProjections.register(titleProjectionDefinition)
      await ctx.plugin(Jsonl, { root: join(root, 'logs') })
      await ctx.plugin(ProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
      const id = brandString<SessionId>('indexed-history')
      const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION, cwd: root, createdAt: 1, isSeeded: false }
      {
        await using writer = await ctx.sessionPersistence.create(header)
        for (let turn = 1; turn <= 55; turn += 1) {
          const seq = (turn - 1) * 3
          const content = [{ type: 'text' as const, text: randomBytes(11 * 1024).toString('base64') }]
          await writer.append([
            { type: 'turn/start', seq: SessionSeq(seq), time: seq + 1, data: { turn } },
            {
              type: 'user/message', seq: SessionSeq(seq + 1), time: seq + 2, surfaceOp: 'append',
              data: createMessage({ role: 'user', content, source: { kind: 'user' } }),
            },
            { type: 'turn/end', seq: SessionSeq(seq + 2), time: seq + 3, data: { turn, reason: { kind: 'completed' } } },
          ] as SessionEvent[])
        }
      }
      const history = new HistoryController(ctx)
      const web = new WebController(ctx, history, (observation) => { observation[Symbol.dispose]() })
      const signal = new AbortController().signal
      const request = { address: { kind: 'session' as const, sessionId: id }, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
      const listed = await ctx.sessionQuery.listSessions(signal)
      history.indexCatalog(listed)
      history.indexCatalog(listed)
      await vi.waitFor(() => { expect(ctx.sessionProjectionCache.hasOpening(id)).toBe(true) })
      const indexed = await history.indexedOpening(request, signal)
      expect(indexed).toMatchObject({ cursor: 164, hasMore: true })
      expect(ctx.sessions.get(id)).toBeUndefined()
      const full = web.follow({ ...request, maxMessages: 501 }, signal)[Symbol.asyncIterator]()
      expect((await full.next()).value).toEqual({ type: 'snapshot', ...indexed })
      await full.return?.()
      const writer = await ctx.sessionPersistence.open(id, 'write')
      await writer.append([
        { type: 'turn/start', seq: SessionSeq(165), time: 166, data: { turn: 56 } },
        { type: 'turn/end', seq: SessionSeq(166), time: 167, data: { turn: 56, reason: { kind: 'completed' } } },
      ])
      await writer.close()
      expect(await history.indexedOpening(request, signal)).toBeUndefined()
      history.indexCatalog(await ctx.sessionQuery.listSessions(signal))
      await vi.waitFor(() => { expect(ctx.sessionProjectionCache.openingReceipt(header)?.cursor).toBe(166) })
      expect((await history.indexedOpening(request, signal))?.cursor).toBe(166)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it('subscribes without reading an Observation and emits later durable events', async () => {
    const f = await fixture()
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    const stream = f.history.observeEvent({ address: f.address }, f.abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { type: 'ready' } })
    expect(observe).not.toHaveBeenCalled()
    f.session.append('turn/start', { turn: 1 })
    expect(await stream.next()).toMatchObject({ value: { type: 'event', event: { seq: 0 } } })
    f.abort.abort()
    expect(await stream.next()).toMatchObject({ done: true })
  })

  it('subscribes to per-event projection changes without an Observation', async () => {
    const f = await fixture()
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    let receive: Parameters<typeof f.ctx.sessionProjections.onEventChanged>[0] | undefined
    const dispose = vi.fn()
    vi.spyOn(f.ctx.sessionProjections, 'onEventChanged').mockImplementation((callback) => {
      receive = callback
      return dispose
    })
    const stream = f.history.observeProjections({ sessionId: f.session.id }, f.abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { type: 'ready' } })
    receive?.(f.session, [{ key: 'title', val: 'new title' }, { key: 'goal', val: null }], SessionSeq(0))
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: 'projection', seq: 0, changes: [{ key: 'title', val: 'new title' }, { key: 'goal', val: null }] },
    })
    expect(observe).not.toHaveBeenCalled()
    f.abort.abort()
    expect(await stream.next()).toMatchObject({ done: true })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reads newest assistant messages within the exclusive/inclusive interval and detects actual truncation', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    const first = f.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'first' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    const second = f.session.append('assistant/message', {
      turn: 1, step: 2,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'second' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    const all = await f.history.assistantOutput(f.session.id, -1, 3, 2, f.abort.signal)
    expect(all.records.map(record => record.event.seq)).toEqual([second.seq, first.seq])
    expect(all.truncated).toBe(false)
    const limited = await f.history.assistantOutput(f.session.id, -1, 3, 1, f.abort.signal)
    expect(limited.records.map(record => record.event.seq)).toEqual([second.seq])
    expect(limited.truncated).toBe(true)
    const interval = await f.history.assistantOutput(f.session.id, first.seq, second.seq, 2, f.abort.signal)
    expect(interval.records.map(record => record.event.seq)).toEqual([second.seq])
    expect(observe).toHaveBeenCalledWith(f.session.id, { signal: f.abort.signal, projectionMode: 'none' })
    await expect(f.history.assistantOutput(f.session.id, -1, 9, 2, f.abort.signal)).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('reads at the observed log end when throughSeq is omitted', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'latest' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    const page = await f.history.events({ address: f.address }, f.abort.signal)
    expect(page.cursor).toBe(f.session.seq - 1)
    expect(page.records.at(-1)?.event.seq).toBe(f.session.seq - 1)
  })

  it('keeps the append copy a model-facing replacement shadowed', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    const replaced = f.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'visible' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    // Compaction rewrites the model-facing surface with a replacement that shadows the original;
    // the human-readable transcript keeps the shadowed append copy.
    const replacement = f.session.append('user/message', createMessage({
      role: 'user', content: [{ type: 'text', text: 'compacted' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: replaced.seq, endSeq: replaced.seq }, sourceEventSeqs: [replaced.seq] })
    const output = await f.history.assistantOutput(f.session.id, -1, replacement.seq, 5, f.abort.signal)
    expect(output.records.map(record => record.event.seq)).toEqual([replaced.seq])
  })

  it('releases the opening Observation when activation has nothing to promote', async () => {
    const f = await fixture()
    const source = await f.ctx.sessionQuery.observeSession(f.session.id)
    const dispose = vi.fn(() => { source[Symbol.dispose]() })
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockResolvedValue({ ...source, [Symbol.dispose]: dispose })
    const stream = f.web.follow({ address: f.address, activate: true }, f.abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    f.abort.abort()
    await stream.next()
    expect(dispose).toHaveBeenCalled()
  })

  it('releases an acquired Observation when caller cancellation wins its return', async () => {
    const f = await fixture()
    const source = await f.ctx.sessionQuery.observeSession(f.session.id)
    const dispose = vi.fn(() => { source[Symbol.dispose]() })
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => {
      f.abort.abort()
      return { ...source, [Symbol.dispose]: dispose }
    })
    await expect(f.history.usingObservation({ sessionId: f.session.id, projection: false }, f.abort.signal)).rejects.toBeDefined()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('maps a non-Error query cancellation to a cancelled Remote error', async () => {
    const f = await fixture()
    // A cross-realm or opaque source may reject with the code alone; the message falls back.
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockRejectedValue({ code: 'SESSION_QUERY_ABORTED' })
    await expect(f.history.events({ address: f.address }, f.abort.signal)).rejects.toMatchObject({
      code: 'gateway/cancelled', message: 'Session read was cancelled',
    })
  })

  it('maps missing subagent Follow reads through the Address error', async () => {
    const f = await fixture()
    const stream = f.web.follow({ address: {
      kind: 'subagent', parentSessionId: f.session.id, childSessionId: brandString<SessionId>('missing-child'), mode: 'continuable',
    } }, f.abort.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toMatchObject({ code: 'subagent/not-found' })
  })

  it('does not promote a live Session when activation was requested', async () => {
    const f = await fixture()
    const promote = vi.fn()
    const web = new WebController(f.ctx, f.history, promote)
    const stream = web.follow({ address: f.address, activate: true }, f.abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { type: 'snapshot' } })
    const pending = stream.next()
    f.abort.abort()
    expect(await pending).toMatchObject({ done: true })
    expect(promote).not.toHaveBeenCalled()
  })
})
