/**
 * Deterministic filesystem-call counts for header reuse during listing.
 * Every fixture is a fresh temporary Session root; the suite never reads a live
 * Session directory and asserts call counts instead of timing thresholds.
 */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath, sessionDir, toHeaderLine } from '../src/format.ts'

const io = vi.hoisted(() => ({
  enabled: false,
  open: new Map<string, number>(),
  stat: new Map<string, number>(),
  readdir: new Map<string, number>(),
  onStat: undefined as undefined | ((path: string, count: number) => void | Promise<void>),
  onHandleRead: undefined as undefined | ((path: string) => void | Promise<void>),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const tally = (calls: Map<string, number>, path: string): number => {
    const next = (calls.get(path) ?? 0) + 1
    calls.set(path, next)
    return next
  }
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0])
      if (io.enabled) tally(io.open, path)
      const handle = await actual.open(...args)
      if (io.onHandleRead === undefined) return handle
      const close = handle.close.bind(handle)
      handle.close = async () => {
        try {
          await close()
        } finally {
          if (io.onHandleRead !== undefined) await io.onHandleRead(path)
        }
      }
      return handle
    }),
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      const identity = await actual.stat(...args)
      if (!io.enabled) return identity
      const count = tally(io.stat, path)
      if (io.onStat !== undefined) await io.onStat(path, count)
      return identity
    }) as typeof actual.stat,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (io.enabled) tally(io.readdir, String(args[0]))
      return actual.readdir(...args)
    }) as typeof actual.readdir,
  }
})

const roots: string[] = []
const contexts: Context[] = []

type MutableSessionHeader = { -readonly [K in keyof SessionHeader]: SessionHeader[K] }

/** Test-only mutable view: SessionHeader is readonly for consumers. */
function mutableHeader(meta: SessionHeader): MutableSessionHeader {
  return meta
}

function header(id: string, cwd: string, createdAt = 1000): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, cwd }
}

function headerLine(meta: SessionHeader): string {
  return `${JSON.stringify(toHeaderLine(meta))}\n`
}

function currentPath(root: string, meta: SessionHeader): string {
  return generationLogPath(root, meta.cwd, meta.id, SESSION_FORMAT_VERSION, 'none')
}

async function seed(root: string, meta: SessionHeader): Promise<string> {
  const path = currentPath(root, meta)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, headerLine(meta))
  return path
}

async function seedReleasedV0(root: string, meta: SessionHeader): Promise<string> {
  const path = generationLogPath(root, meta.cwd, meta.id, 0, 'none')
  await mkdir(dirname(path), { recursive: true })
  const released = {
    type: 'session',
    version: 0,
    id: meta.id,
    createdAt: meta.createdAt,
    cwd: meta.cwd,
    delegationDepth: meta.delegationDepth ?? 0,
  }
  await writeFile(path, `${JSON.stringify(released)}\n`)
  return path
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-list-reuse-'))
  roots.push(root)
  return root
}

async function backend(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  contexts.push(ctx)
  return ctx
}

function resetIo(): void {
  io.open.clear()
  io.stat.clear()
  io.readdir.clear()
  io.onStat = undefined
  io.onHandleRead = undefined
  io.enabled = true
}

function count(calls: Map<string, number>, path: string): number {
  return calls.get(path) ?? 0
}

function fileRevision(identity: {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}): string {
  return SessionPersistenceRevision([
    identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs,
  ].join(':'))
}

function ids(rows: readonly { readonly header: SessionHeader }[]): string[] {
  return rows.map(row => row.header.id).sort()
}

function byId<T extends { readonly header: SessionHeader }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map(row => [row.header.id, row]))
}

afterEach(async () => {
  io.enabled = false
  io.onStat = undefined
  io.onHandleRead = undefined
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('JsonlSessionPersistence listing identity reuse', () => {
  it('keeps one identity stat per unchanged artifact and skips its header open on the next scan', async () => {
    const root = await freshRoot()
    const first = header('warm-a', '/warm-a')
    const second = header('warm-b', '/warm-a')
    const third = header('warm-c', '/warm-b')
    const paths = [await seed(root, first), await seed(root, second), await seed(root, third)]
    const ctx = await backend(root)

    resetIo()
    const cold = await ctx.sessionPersistence.list()
    const coldOpens = new Map(io.open)
    const coldStats = new Map(io.stat)
    io.open.clear()
    io.stat.clear()
    io.readdir.clear()
    const warm = await ctx.sessionPersistence.list()

    expect(ids(cold)).toEqual(['warm-a', 'warm-b', 'warm-c'])
    expect(ids(warm)).toEqual(['warm-a', 'warm-b', 'warm-c'])
    for (const path of paths) {
      expect(count(coldOpens, path)).toBe(1)
      expect(count(io.open, path)).toBe(0)
      // A cold observation costs the pre-read and post-read identity stat; a
      // warm one still costs the fresh identity stat that proves it unchanged.
      expect(count(coldStats, path)).toBe(2)
      expect(count(io.stat, path)).toBe(1)
      expect(count(io.readdir, dirname(path))).toBeGreaterThanOrEqual(1)
    }
    const coldById = byId(cold)
    for (const row of warm) {
      const previous = coldById.get(row.header.id)
      expect(row.revision).toBe(previous?.revision)
      expect(row.sizeBytes).toBe(previous?.sizeBytes)
      expect(row.formatStatus).toBe('current')
      expect(row.location).toEqual({ kind: 'jsonl', path: currentPath(root, row.header) })
    }
  })

  it('does not reuse a header whose identity changes between the pre-read stat and the header read', async () => {
    const root = await freshRoot()
    const cwd = '/replace'
    const meta = header('replace-mid', cwd)
    const path = await seed(root, meta)
    const ctx = await backend(root)

    resetIo()
    io.onStat = async (observed, call) => {
      if (observed !== path || call !== 1) return
      io.onStat = undefined
      await writeFile(path, headerLine(header(meta.id, cwd, 1234567)))
    }
    const [listed] = await ctx.sessionPersistence.list()
    expect(listed?.header.createdAt).toBe(1234567)

    io.enabled = false
    const identity = await stat(path, { bigint: true })
    expect(listed?.sizeBytes).toBe(Number(identity.size))
    expect(listed?.revision).toBe(fileRevision(identity))

    // The mismatched observation was not published, so the next scan repeats it.
    resetIo()
    const [repeated] = await ctx.sessionPersistence.list()
    expect(repeated?.header.createdAt).toBe(1234567)
    expect(count(io.open, path)).toBe(1)
    expect(count(io.stat, path)).toBe(2)

    // A stable observation is reusable.
    resetIo()
    const [stable] = await ctx.sessionPersistence.list()
    expect(stable?.header.createdAt).toBe(1234567)
    expect(count(io.open, path)).toBe(0)
    expect(count(io.stat, path)).toBe(1)
  })

  it('reports consumer header rewrites and appends with the identity that produced them', async () => {
    const root = await freshRoot()
    const cwd = '/mutate'
    const meta = header('mutated-header', cwd)
    const path = await seed(root, meta)
    const ctx = await backend(root)
    await ctx.sessionPersistence.list()

    resetIo()
    await writeFile(path, headerLine(header(meta.id, cwd, 9876543)))
    const [rewritten] = await ctx.sessionPersistence.list()
    expect(rewritten?.header.createdAt).toBe(9876543)
    expect(count(io.open, path)).toBe(1)
    expect(count(io.stat, path)).toBe(2)
    const rewrittenRevision = rewritten?.revision

    resetIo()
    const [stable] = await ctx.sessionPersistence.list()
    expect(stable?.header.createdAt).toBe(9876543)
    expect(stable?.revision).toBe(rewrittenRevision)
    expect(count(io.open, path)).toBe(0)
    expect(count(io.stat, path)).toBe(1)

    resetIo()
    await appendFile(path, `${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`)
    const [appended] = await ctx.sessionPersistence.list()
    expect(appended?.header.createdAt).toBe(9876543)
    expect(appended?.revision).not.toBe(rewrittenRevision)
    expect(appended?.sizeBytes).toBeGreaterThan(rewritten?.sizeBytes ?? 0)
    expect(count(io.open, path)).toBe(1)
    expect(count(io.stat, path)).toBe(2)

    resetIo()
    const [afterAppend] = await ctx.sessionPersistence.list()
    expect(afterAppend?.revision).toBe(appended?.revision)
    expect(count(io.open, path)).toBe(0)
  })

  it('does not publish observations from a failed scan', async () => {
    const root = await freshRoot()
    const sessions = [header('scan-a', '/scan'), header('scan-b', '/scan'), header('scan-c', '/scan')]
    const paths = await Promise.all(sessions.map(async meta => seed(root, meta)))
    const ctx = await backend(root)
    const denied = Object.assign(new Error('identity denied'), { code: 'EACCES' })

    resetIo()
    let observed = 0
    io.onStat = (_, call) => {
      if (call !== 2) return
      observed += 1
      if (observed === 2) throw denied
    }
    await expect(ctx.sessionPersistence.list()).rejects.toBe(denied)
    io.onStat = undefined

    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['scan-a', 'scan-b', 'scan-c'])
    expect(paths.reduce((total, path) => total + count(io.open, path), 0)).toBe(3)
  })

  it('does not publish observations from an aborted scan', async () => {
    const root = await freshRoot()
    const sessions = [header('cancel-a', '/cancel'), header('cancel-b', '/cancel'), header('cancel-c', '/cancel')]
    const paths = await Promise.all(sessions.map(async meta => seed(root, meta)))
    const ctx = await backend(root)
    const reason = new Error('scan cancelled')
    const controller = new AbortController()

    resetIo()
    let completed = 0
    io.onStat = (_, call) => {
      if (call !== 2) return
      completed += 1
      if (completed === 2) controller.abort(reason)
    }
    await expect(ctx.sessionPersistence.list({ signal: controller.signal })).rejects.toBe(reason)
    io.onStat = undefined

    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['cancel-a', 'cancel-b', 'cancel-c'])
    expect(paths.reduce((total, path) => total + count(io.open, path), 0)).toBe(3)
  })

  it('does not let a mutated snapshot poison a later observation', async () => {
    const root = await freshRoot()
    const meta = header('snapshot-mutation', '/snapshot')
    await seed(root, meta)
    const ctx = await backend(root)
    const [cold] = await ctx.sessionPersistence.list()
    mutableHeader(cold!.header).createdAt = 424242

    resetIo()
    const [warm] = await ctx.sessionPersistence.list()
    expect(warm?.header.createdAt).toBe(1000)
    expect(count(io.open, currentPath(root, meta))).toBe(0)

    const snapshot = await ctx.sessionPersistence.stat(meta.id)
    mutableHeader(snapshot!.header).createdAt = 424242
    const observed = await ctx.sessionPersistence.stat(meta.id)
    expect(observed?.header.createdAt).toBe(1000)
  })

  it('reuses a zstd header frame without reopening its prefix', async () => {
    const root = await freshRoot()
    const meta = header('zstd-warm', '/zstd')
    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    contexts.push(ctx)
    const handle = await ctx.sessionPersistence.create(meta)
    await handle.flush()
    await handle.close()
    const path = generationLogPath(root, meta.cwd, meta.id, SESSION_FORMAT_VERSION, 'zstd')

    resetIo()
    const [cold] = await ctx.sessionPersistence.list()
    expect(cold?.formatStatus).toBe('current')
    expect(count(io.open, path)).toBe(1)
    expect(count(io.stat, path)).toBe(2)
    io.open.clear()
    io.stat.clear()

    const [warm] = await ctx.sessionPersistence.list()
    expect(warm?.header.id).toBe(meta.id)
    expect(count(io.open, path)).toBe(0)
    expect(count(io.stat, path)).toBe(1)
  })

  it('omits an artifact that vanishes after its header read', async () => {
    const root = await freshRoot()
    const meta = header('vanish-after-header', '/vanish')
    const path = await seed(root, meta)
    const ctx = await backend(root)

    resetIo()
    io.onHandleRead = async (opened) => {
      if (opened !== path) return
      io.onHandleRead = undefined
      await rm(path)
    }
    await expect(ctx.sessionPersistence.list()).resolves.toEqual([])
  })

  it('surfaces a storage fault from the post-read identity stat', async () => {
    const root = await freshRoot()
    const meta = header('post-stat-fault', '/fault')
    const path = await seed(root, meta)
    const ctx = await backend(root)
    const denied = Object.assign(new Error('post-read identity denied'), { code: 'EACCES' })

    resetIo()
    io.onStat = (observed, call) => {
      if (observed === path && call === 2) throw denied
    }
    await expect(ctx.sessionPersistence.list()).rejects.toBe(denied)
  })

  it('adds a session that appears between scans without reopening unchanged headers', async () => {
    const root = await freshRoot()
    const existing = header('appeared-before', '/appeared')
    const existingPath = await seed(root, existing)
    const ctx = await backend(root)
    await ctx.sessionPersistence.list()

    const appeared = header('appeared-after', '/appeared')
    const appearedPath = await seed(root, appeared)
    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['appeared-after', 'appeared-before'])
    expect(count(io.open, existingPath)).toBe(0)
    expect(count(io.open, appearedPath)).toBe(1)
    expect(count(io.stat, appearedPath)).toBe(2)
  })

  it('selects a higher generation that appears between scans', async () => {
    const root = await freshRoot()
    const cwd = '/generation'
    const meta = header('generation-race', cwd)
    const historicalPath = generationLogPath(root, cwd, meta.id, 3, 'none')
    await mkdir(dirname(historicalPath), { recursive: true })
    await writeFile(historicalPath, `${JSON.stringify({ ...toHeaderLine(meta), version: 3 })}\n`)
    const ctx = await backend(root)
    expect((await ctx.sessionPersistence.list())[0]?.formatStatus).toBe('migration-required')

    const current = header(meta.id, cwd, 777777)
    const currentFile = await seed(root, current)
    resetIo()
    const [selected] = await ctx.sessionPersistence.list()
    expect(selected?.header.createdAt).toBe(777777)
    expect(selected?.formatStatus).toBe('current')
    expect(selected?.location).toEqual({ kind: 'jsonl', path: currentFile })
    expect(count(io.open, currentFile)).toBe(1)
    expect(count(io.stat, currentFile)).toBe(2)
  })

  it('serves concurrent warm scans from the published observation map', async () => {
    const root = await freshRoot()
    const first = header('concurrent-a', '/concurrent')
    const second = header('concurrent-b', '/concurrent')
    const paths = [await seed(root, first), await seed(root, second)]
    const ctx = await backend(root)
    await ctx.sessionPersistence.list()

    resetIo()
    const [left, right] = await Promise.all([
      ctx.sessionPersistence.list(),
      ctx.sessionPersistence.list(),
    ])
    expect(ids(left)).toEqual(['concurrent-a', 'concurrent-b'])
    expect(ids(right)).toEqual(['concurrent-a', 'concurrent-b'])
    for (const path of paths) {
      expect(count(io.open, path)).toBe(0)
      expect(count(io.stat, path)).toBe(2)
    }
  })

  it('keeps reading historical headers because their revisions fingerprint the corpus', async () => {
    const root = await freshRoot()
    const current = header('historical-sibling', '/corpus')
    const historical = header('historical-source', '/corpus')
    const currentFile = await seed(root, current)
    const historicalFile = await seedReleasedV0(root, historical)
    const ctx = await backend(root)

    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['historical-sibling', 'historical-source'])
    const firstHistoricalOpens = count(io.open, historicalFile)
    const firstCurrentOpens = count(io.open, currentFile)
    io.open.clear()
    io.stat.clear()
    io.readdir.clear()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['historical-sibling', 'historical-source'])

    expect(firstHistoricalOpens).toBe(1)
    expect(count(io.open, historicalFile)).toBe(1)
    expect(firstCurrentOpens).toBe(1)
    expect(count(io.open, currentFile)).toBe(0)
  })

  it('drops paths a complete scan no longer observes', async () => {
    const root = await freshRoot()
    const first = header('prune-a', '/prune')
    const second = header('prune-b', '/prune')
    const removed = header('prune-c', '/prune')
    const paths = [await seed(root, first), await seed(root, second), await seed(root, removed)]
    const removedPath = paths[2] as string
    const ctx = await backend(root)
    await ctx.sessionPersistence.list()

    await rm(sessionDir(root, removed.cwd, removed.id), { recursive: true, force: true })
    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['prune-a', 'prune-b'])

    const internals = ctx.sessionPersistence as unknown as {
      headerObservations?: Map<string, unknown>
    }
    expect(internals.headerObservations).toBeInstanceOf(Map)
    expect(internals.headerObservations?.size).toBe(2)
    expect(internals.headerObservations?.has(removedPath)).toBe(false)

    await seed(root, removed)
    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['prune-a', 'prune-b', 'prune-c'])
    expect(count(io.open, removedPath)).toBe(1)
  })

  it('reuses the observed header for stat while still refreshing its identity', async () => {
    const root = await freshRoot()
    const cwd = '/stat'
    const observed = header('stat-observed', cwd)
    const sibling = header('stat-sibling', cwd)
    const observedPath = await seed(root, observed)
    const siblingPath = await seed(root, sibling)
    const ctx = await backend(root)
    await ctx.sessionPersistence.list()

    resetIo()
    const warm = await ctx.sessionPersistence.stat(observed.id)
    expect(warm?.header.id).toBe(observed.id)
    expect(count(io.open, observedPath)).toBe(0)
    expect(count(io.stat, observedPath)).toBe(1)

    resetIo()
    await writeFile(observedPath, headerLine(header(observed.id, cwd, 555555)))
    const refreshed = await ctx.sessionPersistence.stat(observed.id)
    expect(refreshed?.header.createdAt).toBe(555555)
    expect(count(io.open, observedPath)).toBe(1)
    expect(count(io.stat, observedPath)).toBe(2)

    resetIo()
    expect(ids(await ctx.sessionPersistence.list())).toEqual(['stat-observed', 'stat-sibling'])
    expect(count(io.open, observedPath)).toBe(0)
    expect(count(io.open, siblingPath)).toBe(0)
  })
})
