import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import {
  claimIndexOwnership,
  SESSION_QUERY_OWNERSHIP_SUFFIX,
} from '../src/ownership.ts'
import type { IndexOwnership } from '../src/ownership.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryIndexPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-index-ownership-'))
  temporaryDirectories.push(directory)
  return join(directory, 'search.db')
}

function ownershipError(candidate: unknown): SessionQueryError {
  expect(candidate).toBeInstanceOf(SessionQueryError)
  return candidate as SessionQueryError
}

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
  let failure: unknown
  try {
    await operation()
  } catch (error: unknown) {
    failure = error
  }
  return failure
}

async function holding(indexPath: string): Promise<IndexOwnership> {
  return await claimIndexOwnership(indexPath)
}

describe('derived-index ownership', () => {
  it('claims a sidecar beside the index without opening the index itself', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await holding(indexPath)
    try {
      expect(ownership.exclusive).toBe(true)
      expect(ownership.identity.indexPath).toBe(resolve(indexPath))
      expect(ownership.identity.ownerPath).toBe(resolve(`${indexPath}${SESSION_QUERY_OWNERSHIP_SUFFIX}`))
      expect(ownership.identity.instanceId).not.toBe('')
      expect(ownership.identity.source).toBeUndefined()
      expect(existsSync(indexPath)).toBe(false)
      expect(existsSync(ownership.identity.ownerPath as string)).toBe(true)
    } finally {
      await ownership.release()
    }
  })

  it('keeps the caller source label in diagnostics without changing the owned path', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await claimIndexOwnership(indexPath, { source: 'web' })
    try {
      expect(ownership.identity.source).toBe('web')
      expect(ownership.identity.ownerPath).toBe(resolve(`${indexPath}${SESSION_QUERY_OWNERSHIP_SUFFIX}`))
    } finally {
      await ownership.release()
    }
  })

  it('leaves the main index readable and writable while ownership is held', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await holding(indexPath)
    const index = new DatabaseSync(indexPath)
    try {
      index.exec('PRAGMA journal_mode = WAL')
      index.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)')
      index.exec('INSERT INTO t VALUES (7)')
      expect(index.prepare('SELECT count(*) AS c FROM t').get()).toEqual({ c: 1 })
    } finally {
      index.close()
      await ownership.release()
    }
  })

  it('refuses a second claim on the same index path', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await holding(indexPath)
    try {
      const failure = await failureOf(() => claimIndexOwnership(indexPath, { source: 'web' }))
      const error = ownershipError(failure)
      expect(error.code).toBe('SESSION_QUERY_INDEX_FAILED')
      expect(error.message).toContain(resolve(`${indexPath}${SESSION_QUERY_OWNERSHIP_SUFFIX}`))
      expect(error.message).toContain(resolve(indexPath))
      expect(error.message).toContain('another process or service instance')
      expect(error.message).toContain('source web')
    } finally {
      await ownership.release()
    }
  })

  it('frees the path on release while keeping the sidecar for the successor', async () => {
    const indexPath = await temporaryIndexPath()
    const ownerPath = resolve(`${indexPath}${SESSION_QUERY_OWNERSHIP_SUFFIX}`)
    const first = await holding(indexPath)
    await first.release()
    expect(existsSync(ownerPath)).toBe(true)

    const second = await holding(indexPath)
    try {
      expect(second.exclusive).toBe(true)
      expect(existsSync(ownerPath)).toBe(true)
    } finally {
      await second.release()
    }
    expect(existsSync(ownerPath)).toBe(true)
  })

  it('treats an in-memory index as needing no ownership', async () => {
    const ownership = await claimIndexOwnership(':memory:')
    expect(ownership.exclusive).toBe(false)
    expect(ownership.identity.indexPath).toBe(':memory:')
    expect(ownership.identity.ownerPath).toBeUndefined()
    await expect(ownership.release()).resolves.toBeUndefined()
    await expect(ownership.release()).resolves.toBeUndefined()
  })

  it('makes release idempotent', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await holding(indexPath)
    await expect(ownership.release()).resolves.toBeUndefined()
    await expect(ownership.release()).resolves.toBeUndefined()
  })

  it('refuses a sidecar that belongs to another application', async () => {
    const indexPath = await temporaryIndexPath()
    const ownerPath = `${resolve(indexPath)}${SESSION_QUERY_OWNERSHIP_SUFFIX}`
    await mkdir(dirname(ownerPath), { recursive: true })
    const foreign = new DatabaseSync(ownerPath)
    foreign.exec('PRAGMA application_id = 0x12345678')
    foreign.close()

    const failure = await failureOf(() => claimIndexOwnership(indexPath))
    const error = ownershipError(failure)
    expect(error.code).toBe('SESSION_QUERY_INDEX_FAILED')
    expect(error.message).toContain('belongs to another application')
    expect(error.message).toContain(ownerPath)
  })

  it('refuses a non-empty sidecar without the ownership application id', async () => {
    const indexPath = await temporaryIndexPath()
    const ownerPath = `${resolve(indexPath)}${SESSION_QUERY_OWNERSHIP_SUFFIX}`
    await mkdir(dirname(ownerPath), { recursive: true })
    const foreign = new DatabaseSync(ownerPath)
    foreign.exec('CREATE TABLE foreign_rows (x INTEGER)')
    foreign.close()

    const failure = await failureOf(() => claimIndexOwnership(indexPath))
    const error = ownershipError(failure)
    expect(error.code).toBe('SESSION_QUERY_INDEX_FAILED')
    expect(error.message).toContain('is not an empty or recognized ownership database')
  })

  it('reports an unusable sidecar instead of claiming it', async () => {
    const indexPath = await temporaryIndexPath()
    const ownerPath = `${resolve(indexPath)}${SESSION_QUERY_OWNERSHIP_SUFFIX}`
    await writeFile(ownerPath, 'not a sqlite database')

    const failure = await failureOf(() => claimIndexOwnership(indexPath))
    const error = ownershipError(failure)
    expect(error.code).toBe('SESSION_QUERY_INDEX_FAILED')
    expect(error.message).toContain('is unusable')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('reports a sidecar path that cannot be created', async () => {
    const indexPath = await temporaryIndexPath()
    await writeFile(indexPath, 'blocking regular file')
    const blockedIndexPath = join(indexPath, 'search.db')

    const failure = await failureOf(() => claimIndexOwnership(blockedIndexPath))
    const error = ownershipError(failure)
    expect(error.code).toBe('SESSION_QUERY_INDEX_FAILED')
    expect(error.message).toContain('cannot be created')
  })

  it('reports a sidecar path that cannot be opened', async () => {
    const indexPath = await temporaryIndexPath()
    const ownerPath = `${resolve(indexPath)}${SESSION_QUERY_OWNERSHIP_SUFFIX}`
    await mkdir(ownerPath, { recursive: true })

    const failure = await failureOf(() => claimIndexOwnership(indexPath))
    const error = ownershipError(failure)
    expect(error.code).toBe('SESSION_QUERY_INDEX_FAILED')
    expect(error.message).toMatch(/cannot be opened|is unusable/)
  })

  it('creates no file beside the index other than the ownership sidecar', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await holding(indexPath)
    await ownership.release()
    const directory = dirname(resolve(indexPath))
    const indexName = basename(resolve(indexPath))
    const entries = await readdir(directory)
    expect(entries.filter(entry => entry !== `${indexName}${SESSION_QUERY_OWNERSHIP_SUFFIX}`)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('derived-index ownership mode', () => {
  it('creates the sidecar owner-only', async () => {
    const indexPath = await temporaryIndexPath()
    const ownership = await holding(indexPath)
    try {
      expect((await stat(ownership.identity.ownerPath as string)).mode & 0o777).toBe(0o600)
    } finally {
      await ownership.release()
    }
  })
})
