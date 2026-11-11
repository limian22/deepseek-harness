/**
 * Cross-process ownership of one derived session-search index path.
 *
 * The main index database must stay readable by other connections (WAL reads,
 * worker writers, external inspection), so ownership lives in a dedicated
 * sidecar database beside the index. Only that sidecar is opened in SQLite's
 * exclusive locking mode: the first write takes and holds the file lock until
 * the connection closes, and the operating system releases it when the owning
 * process exits. Nothing is ever deleted, and no stale-owner guess is made, so
 * a crashed owner cannot leave a lock that a successor must break.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/ownership
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'

/** Sidecar suffix appended to the derived-index path to address its ownership database. */
export const SESSION_QUERY_OWNERSHIP_SUFFIX = '.owner.sqlite'

/** SQLite application id marking a recognized ownership database. */
export const SESSION_QUERY_OWNERSHIP_APPLICATION_ID = 0x4453514f

/** In-memory index path, which has no cross-process identity to own. */
const MEMORY_PATH = ':memory:'

/** Optional attribution for one ownership claim. */
export interface IndexOwnershipOptions {
  /**
   * Profile, persistence-source, or logical-service label reported in
   * diagnostics. It never participates in the lock key or any filesystem path.
   */
  readonly source?: string
}

/** Exact attribution recorded for one ownership claim. */
export interface IndexOwnershipIdentity extends IndexOwnershipOptions {
  /** Resolved derived-index path this claim owns; `:memory:` for an in-memory index. */
  readonly indexPath: string
  /** Sidecar ownership database, absent for an in-memory index. */
  readonly ownerPath?: string
  /** Per-claim random identifier used only in diagnostics and error messages. */
  readonly instanceId: string
}

/** One held derived-index ownership. */
export interface IndexOwnership {
  /** Diagnostics-only attribution of this claim. */
  readonly identity: IndexOwnershipIdentity
  /** Whether this claim holds the sidecar lock; `false` for an in-memory index. */
  readonly exclusive: boolean
  /**
   * Close the ownership connection, which is what releases the cross-process
   * lock. Idempotent; the sidecar file is never removed.
   * @returns resolution after the ownership connection is closed.
   */
  release(): Promise<void>
}

/**
 * Claim one derived-index path for this process.
 *
 * The caller opens the index database itself afterwards and releases this
 * claim only after that database is closed, so no successor can take the path
 * while an index connection is still live.
 * @param indexPath - derived-index path from the deployment configuration, or `:memory:`.
 * @param options - optional profile or source label for diagnostics.
 * @returns the held claim, or a no-op claim for `:memory:`.
 * @throws {SessionQueryError} `SESSION_QUERY_INDEX_FAILED` when another process
 * or service instance owns the path, or when the sidecar cannot be recognized
 * or used.
 */
export async function claimIndexOwnership(
  indexPath: string,
  options: IndexOwnershipOptions = {},
): Promise<IndexOwnership> {
  const resolved = indexPath === MEMORY_PATH ? MEMORY_PATH : resolve(indexPath)
  const instanceId = randomUUID()
  if (resolved === MEMORY_PATH) {
    return {
      identity: { indexPath: resolved, instanceId, ...sourceOf(options) },
      exclusive: false,
      release: () => Promise.resolve(),
    }
  }
  const ownerPath = `${resolved}${SESSION_QUERY_OWNERSHIP_SUFFIX}`
  const identity: IndexOwnershipIdentity = {
    indexPath: resolved,
    ownerPath,
    instanceId,
    ...sourceOf(options),
  }
  await createOwnerOnlyFile(ownerPath, identity)
  const db = openOwnershipDatabase(ownerPath, identity)
  try {
    assertOwnershipDatabase(db, ownerPath, identity)
    acquireExclusiveLock(db)
  } catch (error: unknown) {
    closeAfterFailedClaim(db)
    if (error instanceof SessionQueryError) throw error
    if ((error as { errcode?: number }).errcode === 5) {
      throw ownershipFailure(
        ownerPath,
        `is owned by another process or service instance (index "${identity.indexPath}")`,
        error,
        identity,
      )
    }
    throw ownershipFailure(ownerPath, 'is unusable', error, identity)
  }
  let released = false
  return {
    identity,
    exclusive: true,
    release: () => {
      if (released) return Promise.resolve()
      released = true
      db.close()
      return Promise.resolve()
    },
  }
}

function sourceOf(options: IndexOwnershipOptions): IndexOwnershipOptions {
  return options.source === undefined ? {} : { source: options.source }
}

/** Create the sidecar owner-only; an existing sidecar is adopted by {@link openOwnershipDatabase}. */
async function createOwnerOnlyFile(path: string, identity: IndexOwnershipIdentity): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if (existsSync(path)) return
    throw ownershipFailure(path, 'cannot be created', error, identity)
  }
}

function openOwnershipDatabase(path: string, identity: IndexOwnershipIdentity): DatabaseSync {
  try {
    return new DatabaseSync(path)
  } catch (error: unknown) {
    throw ownershipFailure(path, 'cannot be opened', error, identity)
  }
}

function closeAfterFailedClaim(db: DatabaseSync): void {
  /* v8 ignore next 5 -- closing a connection that just failed to claim cannot add an actionable error */
  try {
    db.close()
  } catch {
    // The claim failure remains the actionable cause.
  }
}

/** Refuse a foreign ownership database, then stamp the recognized application id. */
function assertOwnershipDatabase(
  db: DatabaseSync,
  ownerPath: string,
  identity: IndexOwnershipIdentity,
): void {
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  if (applicationId !== 0 && applicationId !== SESSION_QUERY_OWNERSHIP_APPLICATION_ID) {
    throw ownershipFailure(ownerPath, 'belongs to another application', undefined, identity)
  }
  if (applicationId === 0) {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' LIMIT 1",
    ).all() as Array<{ name: string }>
    if (tables.length > 0) {
      throw ownershipFailure(ownerPath, 'is not an empty or recognized ownership database', undefined, identity)
    }
  }
  db.exec(`PRAGMA application_id = ${SESSION_QUERY_OWNERSHIP_APPLICATION_ID}`)
}

/** Take and hold the sidecar's exclusive file lock through the connection lifetime. */
function acquireExclusiveLock(db: DatabaseSync): void {
  db.exec('PRAGMA locking_mode = EXCLUSIVE')
  db.exec('BEGIN IMMEDIATE')
  db.exec('COMMIT')
}

function ownershipFailure(
  path: string,
  detail: string,
  cause: unknown,
  identity: IndexOwnershipIdentity,
): SessionQueryError {
  const attribution = ` [instance ${identity.instanceId}${identity.source === undefined ? '' : `, source ${identity.source}`}]`
  return new SessionQueryError(
    `session-search ownership database at "${path}" ${detail}${attribution}. Configure a distinct derived-index path for each profile and persistence source.`,
    'SESSION_QUERY_INDEX_FAILED',
    cause === undefined ? undefined : { cause },
  )
}
