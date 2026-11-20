/**
 * Worker-offloaded cold reads for the JSONL backend. The worker owns a second
 * provider instance over the same root and only ever opens read handles; these
 * tests pin the published read results, the process-boundary validation, the
 * queue/dispose lifecycle, and the explicit source-churn retry path.
 */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceCorruptionError,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import { Worker } from 'node:worker_threads'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '../src/format.ts'
import {
  JsonlReadWorkerClient,
  JsonlReadWorkerFailureError,
  READ_WORKER_SOURCE_CHANGE_ATTEMPTS,
} from '../src/read-worker-client.ts'
import {
  parseReadLogRequest,
  parseReadLogResponse,
  parseReadWorkerConfig,
  parseReadWorkerMessage,
} from '../src/read-worker-protocol.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []
const contexts: Context[] = []
// oxlint-disable-next-line typescript/unbound-method -- Each use supplies the captured Worker as the explicit receiver.
const originalPost = Worker.prototype.postMessage

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-read-worker-'))
  roots.push(root)
  return root
}

interface MountOptions {
  readonly root: string
  readonly compression?: 'none' | 'zstd'
  readonly readWorker?: boolean
}

async function mount(options: MountOptions): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, {
    root: options.root,
    compression: options.compression ?? 'none',
    readWorker: options.readWorker ?? false,
  })
  return ctx
}

interface SeededSession {
  readonly id: SessionId
  readonly path: string
  readonly events: readonly SessionEvent[]
}

/** Write one durable session artifact through the provider's normal write path. */
async function seed(root: string, id: string, compression: 'none' | 'zstd' = 'none'): Promise<SeededSession> {
  const ctx = await mount({ root, compression })
  const header: SessionHeader = meta(id)
  const events = oneTurnLog()
  const writer = await ctx.sessionPersistence.create(header)
  try {
    await writer.append(events)
  } finally {
    await writer.close()
  }
  return { id: header.id, path: generationLogPath(root, undefined, header.id, SESSION_FORMAT_VERSION, compression), events }
}

interface ReadSessionResult {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
}

/** Read one session exactly as a persistence consumer does. */
async function readSession(ctx: Context, id: SessionId): Promise<ReadSessionResult> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    const result = await handle.read()
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: result.events }
  } finally {
    await handle.close()
  }
}

/** Capture one physical revision token the way the provider itself derives it. */
async function currentRevision(ctx: Context, id: SessionId): Promise<SessionPersistenceRevision> {
  const snapshot = await ctx.sessionPersistence.stat(id)
  if (snapshot === undefined) throw new Error(`session "${id}" has no artifact`)
  return snapshot.revision
}

interface PostSpyLike {
  readonly mock: { readonly contexts: readonly unknown[] }
}

/** The worker that most recently received a `postMessage` through the spy. */
function workerOf(post: PostSpyLike): Worker {
  const worker = post.mock.contexts.at(-1)
  if (!(worker instanceof Worker)) throw new Error('postMessage spy has no worker receiver')
  return worker
}

/** Emit one message as if it came from the captured worker. */
function workerMessage(post: PostSpyLike, value: unknown): void {
  workerOf(post).emit('message', value)
}

describe('read worker cold reads', () => {
  it.for(['none', 'zstd'] as const)('decodes %s current logs into validated detached results', async (compression) => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-current', compression)
    const before = await readFile(seeded.path)
    const beforeStat = await stat(seeded.path, { bigint: true })
    const post = vi.spyOn(Worker.prototype, 'postMessage')

    const ctx = await mount({ root, compression, readWorker: true })
    const first = await readSession(ctx, seeded.id)

    expect(first.events).toEqual(seeded.events)
    expect(first.header.id).toBe(seeded.id)
    expect(first.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(first.inheritedEventCount).toBe(0)
    expect(post).toHaveBeenCalledTimes(1)
    // The worker's decoded graph crosses a thread boundary, so the caller must
    // re-establish the frozen sharing state it promises to consumers.
    expect(Object.isFrozen(first.events[0])).toBe(true)

    expect(await readFile(seeded.path)).toEqual(before)
    const afterStat = await stat(seeded.path, { bigint: true })
    expect([afterStat.size, afterStat.mtimeNs, afterStat.ino])
      .toEqual([beforeStat.size, beforeStat.mtimeNs, beforeStat.ino])
    const suffix = compression === 'zstd' ? '.zstd' : ''
    expect((await readdir(dirname(seeded.path))).filter(name => name !== 'session.lock'))
      .toEqual([`session.v${SESSION_FORMAT_VERSION}.jsonl${suffix}`])
  })

  it.for(['none', 'zstd'] as const)('repairs a torn %s tail before a write opened after a worker read', async (compression) => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-read-then-repair', compression)
    await appendFile(seeded.path, compression === 'none'
      ? '{"type":"turn/start","seq":'
      : Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    const damaged = await readFile(seeded.path)
    const ctx = await mount({ root, compression, readWorker: true })
    expect((await readSession(ctx, seeded.id)).events).toEqual(seeded.events)
    expect(await readFile(seeded.path)).toEqual(damaged)
    const next: SessionEvent = {
      type: 'turn/start', seq: SessionSeq(seeded.events.length), time: 100, data: { turn: 2 },
    }
    const writer = await ctx.sessionPersistence.open(seeded.id, 'write')
    try {
      await writer.append([next])
    } finally {
      await writer.close()
    }
    const verifier = await mount({ root, compression })
    expect((await readSession(verifier, seeded.id)).events).toEqual([...seeded.events, next])
  })

  it('reuses one lazy worker across sessions and serves an unchanged open from the backend memo', async () => {
    const root = await temporaryRoot()
    const first = await seed(root, 'worker-reuse-a')
    const second = await seed(root, 'worker-reuse-b')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const ctx = await mount({ root, readWorker: true })

    expect((await readSession(ctx, first.id)).events).toEqual(first.events)
    expect(post).toHaveBeenCalledTimes(1)
    expect((await readSession(ctx, second.id)).events).toEqual(second.events)
    expect(post).toHaveBeenCalledTimes(2)
    // An unchanged revision is served from the backend's own cold-log memo, so
    // the same artifact is not sent to the worker twice.
    expect((await readSession(ctx, first.id)).events).toEqual(first.events)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('keeps disabled configuration and historical generations on the existing in-process paths', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-disabled')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const disabled = await mount({ root, readWorker: false })
    expect((await readSession(disabled, seeded.id)).events).toEqual(seeded.events)
    expect(post).not.toHaveBeenCalled()

    const historicalRoot = await temporaryRoot()
    const historicalId = SessionId('worker-historical')
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
    const header = { type: 'session', version: 3, id: historicalId, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const historicalPath = generationLogPath(historicalRoot, undefined, historicalId, 3, 'none')
    await mkdir(dirname(historicalPath), { recursive: true })
    await writeFile(historicalPath, `${JSON.stringify(header)}\n${rows.map(row => `${JSON.stringify(row)}\n`).join('')}`)
    const historical = await mount({ root: historicalRoot, readWorker: true })
    const read = await readSession(historical, historicalId)
    expect(read.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(read.events.length).toBe(rows.length)
    expect(post).not.toHaveBeenCalled()
    expect(await readFile(historicalPath, 'utf8')).toContain('"version":3')
  })

  it('reports a corrupt current log through the worker as the seam corruption error', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-corrupt')
    // A damaged header is committed damage: recoverable tail handling cannot hide it.
    await writeFile(seeded.path, '{"type":"session"\n{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}\n')
    const ctx = await mount({ root, readWorker: true })
    const failure = await readSession(ctx, seeded.id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((failure as Error).message).toContain(seeded.path)
  })

  it('retries a bounded number of source changes before using the existing stable-read path', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-churn')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    let attempts = 0
    post.mockImplementation((message: unknown) => {
      attempts += 1
      const request = parseReadLogRequest(message)
      queueMicrotask(() => {
        workerMessage(post, { kind: 'response', response: { request: request.request, ok: false, code: 'source-changed' } })
      })
    })
    const ctx = await mount({ root, readWorker: true })
    const read = await readSession(ctx, seeded.id)
    expect(attempts).toBe(READ_WORKER_SOURCE_CHANGE_ATTEMPTS)
    expect(read.events).toEqual(seeded.events)
  })

  it('retries with the newer revision after a source change and returns the appended events', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-append')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const appended: SessionEvent = { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } }
    let attempts = 0
    post.mockImplementation((message: unknown) => {
      attempts += 1
      const request = parseReadLogRequest(message)
      if (attempts === 1) {
        void appendFile(seeded.path, `${JSON.stringify(appended)}\n`).then(() => {
          workerMessage(post, { kind: 'response', response: { request: request.request, ok: false, code: 'source-changed' } })
        })
        return
      }
      originalPost.call(workerOf(post), message)
    })
    const ctx = await mount({ root, readWorker: true })
    const read = await readSession(ctx, seeded.id)
    expect(attempts).toBe(2)
    expect(read.events).toEqual([...seeded.events, appended])
  })

  it('surfaces a typed worker failure and rebuilds the worker for the next read', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-send-failure')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    // A non-Error throw is normalized to a typed failure that keeps an Error cause.
    post.mockImplementationOnce(() => { throw 'postMessage failed' })
    const ctx = await mount({ root, readWorker: true })
    const failure = await readSession(ctx, seeded.id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(post).toHaveBeenCalledTimes(1)
    // A failed worker is never reused silently.
    expect((await readSession(ctx, seeded.id)).events).toEqual(seeded.events)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('surfaces a malformed worker response and rebuilds the worker for the next read', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-malformed')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    post.mockImplementationOnce(() => {
      queueMicrotask(() => {
        workerMessage(post, { kind: 'response', response: { request: 1, ok: true } })
      })
    })
    const ctx = await mount({ root, readWorker: true })
    const failure = await readSession(ctx, seeded.id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
    expect((await readSession(ctx, seeded.id)).events).toEqual(seeded.events)
  })

  it('surfaces a worker thread error and rebuilds the worker for the next read', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-error')
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    post.mockImplementationOnce(() => {
      queueMicrotask(() => {
        workerOf(post).emit('error', new Error('worker crashed'))
      })
    })
    const ctx = await mount({ root, readWorker: true })
    const failure = await readSession(ctx, seeded.id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
    expect((await readSession(ctx, seeded.id)).events).toEqual(seeded.events)
  })

  it('isolates one cancelled waiter from a concurrent request', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-cancel')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    const cancelled = new AbortController()
    try {
      const first = client.read({ id: seeded.id, path: seeded.path, revision })
      const second = client.read({ id: seeded.id, path: seeded.path, revision }, cancelled.signal)
      cancelled.abort(new Error('waiter cancelled'))
      const [firstResult, secondResult] = await Promise.allSettled([first, second])
      expect(firstResult.status).toBe('fulfilled')
      if (firstResult.status === 'fulfilled') expect(firstResult.value.events).toEqual(seeded.events)
      expect(secondResult.status).toBe('rejected')
      expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
    } finally {
      await client.dispose()
    }
  })

  it('dispose waits for worker termination and rejects reads issued afterwards', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-dispose')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
    await client.dispose()
    expect(terminate).toHaveBeenCalled()
    const later = await client.read({ id: seeded.id, path: seeded.path, revision }).catch((error: unknown) => error)
    expect(later).toBeInstanceOf(JsonlReadWorkerFailureError)
  })

  it('service disposal terminates the owned worker', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-service-dispose')
    const ctx = await mount({ root, readWorker: true })
    expect((await readSession(ctx, seeded.id)).events).toEqual(seeded.events)
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    await ctx.fiber.dispose()
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})

describe('read worker queue and protocol containment', () => {
  it('rejects an already-cancelled waiter without spawning a worker', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-pre-aborted')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      const failure = await client.read({ id: seeded.id, path: seeded.path, revision }, AbortSignal.abort(new Error('already cancelled'))).catch((error: unknown) => error)
      expect((failure as Error).message).toBe('already cancelled')
      expect(post).not.toHaveBeenCalled()
    } finally {
      await client.dispose()
    }
  })

  it('skips a waiter cancelled while the worker is starting', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-cancel-boot')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    const controller = new AbortController()
    try {
      const pending = client.read({ id: seeded.id, path: seeded.path, revision }, controller.signal)
      controller.abort(new Error('cancelled during startup'))
      const failure = await pending.catch((error: unknown) => error)
      expect((failure as Error).message).toBe('cancelled during startup')
      expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
      expect(post).toHaveBeenCalledTimes(1)
    } finally {
      await client.dispose()
    }
  })

  it('discards the late response of a waiter cancelled in flight', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-cancel-active')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const controller = new AbortController()
    post.mockImplementationOnce((message: unknown) => {
      const request = parseReadLogRequest(message)
      controller.abort(new Error('waiter gave up'))
      queueMicrotask(() => {
        workerMessage(post, { kind: 'response', response: { request: request.request, ok: false, code: 'source-changed' } })
      })
    })
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      const failure = await client.read({ id: seeded.id, path: seeded.path, revision }, controller.signal)
        .catch((error: unknown) => error)
      expect((failure as Error).message).toBe('waiter gave up')
      expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
    } finally {
      await client.dispose()
    }
  })

  it('normalizes a non-Error cancellation reason', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-cancel-reason')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    const controller = new AbortController()
    try {
      const first = client.read({ id: seeded.id, path: seeded.path, revision })
      const second = client.read({ id: seeded.id, path: seeded.path, revision }, controller.signal)
      controller.abort('plain reason')
      const [firstResult, secondResult] = await Promise.allSettled([first, second])
      expect(firstResult.status).toBe('fulfilled')
      expect(secondResult.status).toBe('rejected')
      if (secondResult.status === 'rejected') {
        expect(secondResult.reason).toBeInstanceOf(Error)
        expect((secondResult.reason as Error).message).toBe('read worker request aborted')
      }
    } finally {
      await client.dispose()
    }
  })

  it('surfaces a worker that rejects its spawn configuration as a typed failure', async () => {
    // An empty root is rejected by the worker's own boundary validation, which
    // is the same startup-failure path as any malformed spawn configuration.
    const client = new JsonlReadWorkerClient({ root: '', compression: 'none' })
    try {
      const failure = await client.read({
        id: SessionId('worker-startup'),
        path: join(tmpdir(), 'dsh-read-worker-startup.jsonl'),
        revision: SessionPersistenceRevision('1:2:3:4:5'),
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
      expect((failure as Error).message).toContain('failed to start')
    } finally {
      await client.dispose()
    }
  })

  it('rejects the in-flight read when disposed and still awaits termination', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-dispose-inflight')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    post.mockImplementationOnce(() => {})
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    const pending = client.read({ id: seeded.id, path: seeded.path, revision }).catch((error: unknown) => error)
    await client.dispose()
    expect(terminate).toHaveBeenCalledTimes(1)
    const failure = await pending
    expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
    expect((failure as Error).message).toBe('JSONL read worker client is disposed')
  })

  it('abandons the worker on an unsolicited response and rebuilds for the next read', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-unsolicited')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
      workerMessage(post, { kind: 'response', response: { request: 2, ok: false, code: 'source-changed' } })
      expect(terminate).toHaveBeenCalled()
      expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
    } finally {
      await client.dispose()
    }
  })

  it('abandons the worker on a mismatched response token', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-token-mismatch')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    post.mockImplementationOnce((message: unknown) => {
      const request = parseReadLogRequest(message)
      queueMicrotask(() => {
        workerMessage(post, { kind: 'response', response: { request: request.request + 1, ok: false, code: 'source-changed' } })
      })
    })
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      const failure = await client.read({ id: seeded.id, path: seeded.path, revision }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
      expect((failure as Error).message).toBe('JSONL read worker answered a different request')
    } finally {
      await client.dispose()
    }
  })

  it('abandons the worker on a mismatched response revision', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-revision-mismatch')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    post.mockImplementationOnce((message: unknown) => {
      const request = parseReadLogRequest(message)
      queueMicrotask(() => {
        workerMessage(post, {
          kind: 'response',
          response: {
            request: request.request, ok: true, header: meta('worker-revision-mismatch'), inheritedEventCount: 0,
            events: [], revision: '0:0:0:0:0',
          },
        })
      })
    })
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      const failure = await client.read({ id: seeded.id, path: seeded.path, revision }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
      expect((failure as Error).message).toBe('JSONL read worker returned a different revision')
    } finally {
      await client.dispose()
    }
  })

  it('abandons the worker on an unexpected lifecycle message', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-lifecycle')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      expect((await client.read({ id: seeded.id, path: seeded.path, revision })).events).toEqual(seeded.events)
      workerMessage(post, { kind: 'ready' })
      expect(terminate).toHaveBeenCalled()
    } finally {
      await client.dispose()
    }
  })

  it('surfaces a worker exit while a request is in flight', async () => {
    const root = await temporaryRoot()
    const seeded = await seed(root, 'worker-exit')
    const ctx = await mount({ root, readWorker: false })
    const revision = await currentRevision(ctx, seeded.id)
    const post = vi.spyOn(Worker.prototype, 'postMessage')
    post.mockImplementationOnce(() => {
      queueMicrotask(() => { workerOf(post).emit('exit', 1) })
    })
    const client = new JsonlReadWorkerClient({ root, compression: 'none' })
    try {
      const failure = await client.read({ id: seeded.id, path: seeded.path, revision }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(JsonlReadWorkerFailureError)
      expect((failure as Error).message).toContain('exited')
    } finally {
      await client.dispose()
    }
  })
})

describe('read worker process-boundary validation', () => {
  it('accepts a well-formed spawn configuration', () => {
    expect(parseReadWorkerConfig({ root: '/tmp/sessions', compression: 'zstd' })).toEqual({
      root: '/tmp/sessions', compression: 'zstd',
    })
  })

  it('rejects malformed spawn configurations', () => {
    for (const value of [undefined, null, 'root', { root: '' }, { root: 5 }, { root: '/a', compression: 'gzip' }]) {
      expect(() => parseReadWorkerConfig(value)).toThrow()
    }
  })

  it('accepts one well-formed request', () => {
    const request = { request: 1, id: 'session-1', path: '/root/log.jsonl', revision: '1:2:3:4:5' }
    expect(parseReadLogRequest(request)).toEqual(request)
  })

  it('rejects malformed requests', () => {
    const valid = { request: 1, id: 'session-1', path: '/root/log.jsonl', revision: '1:2:3:4:5' }
    for (const value of [
      null,
      { ...valid, request: -1 },
      { ...valid, request: 1.5 },
      { ...valid, id: '' },
      { ...valid, path: '' },
      { ...valid, revision: '' },
      { ...valid, revision: 7 },
    ]) {
      expect(() => parseReadLogRequest(value)).toThrow()
    }
  })

  it('accepts ready, failure, and response messages', () => {
    expect(parseReadWorkerMessage({ kind: 'ready' })).toEqual({ kind: 'ready' })
    expect(parseReadWorkerMessage({ kind: 'failed', message: 'boot failed' })).toEqual({
      kind: 'failed', message: 'boot failed',
    })
    const response = {
      request: 2, ok: true, header: meta('session-1'), inheritedEventCount: 0,
      events: oneTurnLog(), revision: '1:2:3:4:5',
    }
    expect(parseReadWorkerMessage({ kind: 'response', response })).toMatchObject({ kind: 'response' })
  })

  it('rejects malformed messages and responses', () => {
    const validResponse = {
      request: 2, ok: true, header: meta('session-1'), inheritedEventCount: 0,
      events: oneTurnLog(), revision: '1:2:3:4:5',
    }
    for (const value of [
      null,
      [],
      { kind: 'unknown' },
      { kind: 'failed' },
      { kind: 'failed', message: '' },
      { kind: 'ready', extra: true },
      { kind: 'response' },
      { kind: 'response', response: { ...validResponse, request: -1 } },
      { kind: 'response', response: { ...validResponse, request: 0 } },
      { kind: 'response', response: { ...validResponse, ok: 'yes' } },
      { kind: 'response', response: { ...validResponse, events: {} } },
      { kind: 'response', response: { ...validResponse, header: {} } },
      { kind: 'response', response: { ...validResponse, inheritedEventCount: -1 } },
      { kind: 'response', response: { ...validResponse, revision: 4 } },
      { kind: 'response', response: { ...validResponse, revision: '' } },
    ]) {
      expect(() => parseReadWorkerMessage(value)).toThrow()
    }
    expect(() => parseReadLogResponse({ ...validResponse, ok: 'yes' })).toThrow()
    expect(() => parseReadLogResponse({ ...validResponse, events: [{ nope: true }] })).toThrow()
    expect(() => parseReadLogResponse({ ...validResponse, events: [{ type: '', seq: 0 }] })).toThrow()
    expect(() => parseReadLogResponse({ ...validResponse, events: [{ type: 'turn/start', seq: -1 }] })).toThrow()
    expect(() => parseReadLogResponse({ ...validResponse, events: [{ type: 'turn/start', seq: 1.5 }] })).toThrow()
    expect(() => parseReadLogResponse({ ...validResponse, extra: true })).toThrow()
    expect(() => parseReadLogResponse({ request: 2, ok: false, code: 'unsupported' })).toThrow()
    expect(() => parseReadLogResponse({ request: 2, ok: false, code: 'source-changed', extra: true })).toThrow()
    for (const failure of [
      { name: '', message: 'x' },
      { name: 'Error', message: 5 },
      { name: 'Error', message: 'x', stack: 5 },
      { name: 'Error', message: 'x', errorCode: 5 },
      { name: 'Error', message: 'x', extra: true },
    ]) {
      expect(() => parseReadLogResponse({ request: 2, ok: false, code: 'decode-error', ...failure })).toThrow()
    }
  })

  it('rejects malformed headers and event rows', () => {
    const validResponse = {
      request: 2, ok: true, header: meta('session-1'), inheritedEventCount: 0,
      events: [], revision: '1:2:3:4:5',
    }
    for (const header of [
      { ...meta('session-1'), id: 5 },
      { ...meta('session-1'), id: '' },
      { ...meta('session-1'), version: 3 },
      { ...meta('session-1'), createdAt: -1 },
      { ...meta('session-1'), isSeeded: 'yes' },
      { ...meta('session-1'), cwd: 5 },
      { ...meta('session-1'), parentSession: '' },
      { ...meta('session-1'), origin: 'other' },
      { ...meta('session-1'), delegationDepth: -1 },
      { ...meta('session-1'), agentPreset: 4 },
      { ...meta('session-1'), extra: true },
    ]) {
      expect(() => parseReadLogResponse({ ...validResponse, header })).toThrow()
    }
    const header = meta('session-1')
    expect(parseReadLogResponse({
      ...validResponse,
      header: {
        ...header, cwd: '/w', parentSession: SessionId('parent'), origin: 'subagent',
        delegationDepth: 1, agentPreset: 'minimal',
      },
    })).toMatchObject({ ok: true })
  })
})
