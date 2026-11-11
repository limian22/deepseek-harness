/** SQLite schema for the disposable session full-text read model. */

import type { DatabaseSync } from 'node:sqlite'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { claimIndexOwnership } from './ownership.ts'

/** Current derived-index schema version. Incompatible versions reset in place. */
export const SESSION_QUERY_SQLITE_SCHEMA_VERSION = 9

/** SQLite application id protecting unrelated databases from derived resets. */
export const SESSION_QUERY_SQLITE_APPLICATION_ID = 0x44534851

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

const DERIVED_USER_TABLES = new Set([
  'search_state',
  'persisted_sessions',
  'persisted_docs',
  'persisted_docs_data',
  'persisted_docs_idx',
  'persisted_docs_content',
  'persisted_docs_docsize',
  'persisted_docs_config',
  'sync_sessions',
])

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** One opened derived index and the cross-process claim that protects its path. */
export interface OpenedSearchDatabase {
  /** Initialized database handle owned by the search service. */
  readonly db: DatabaseSync
  /**
   * Close the ownership sidecar, which releases the path for a successor.
   * Call only after {@link OpenedSearchDatabase.db} is closed. Idempotent.
   * @returns resolution after the ownership connection is closed.
   */
  release(): Promise<void>
}

/**
 * Open, validate, and initialize persistent and connection-local schemas.
 *
 * The index path is claimed before the database is opened, so a second process
 * or service instance is refused with a diagnosable failure instead of racing
 * this connection. A filesystem path that cannot be opened releases the claim.
 * @param path - dedicated derived-index path or `:memory:`; missing filesystem paths are created owner-only.
 * @param journalMode - validated SQLite journal mode.
 * @returns initialized database handle plus its ownership release.
 */
export async function openSearchDatabase(
  path: string,
  journalMode: JournalMode,
): Promise<OpenedSearchDatabase> {
  const actual = path === ':memory:' ? path : resolve(path)
  const ownership = await claimIndexOwnership(actual)
  try {
    if (actual !== ':memory:') await createDatabaseFile(actual)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(actual)
    try {
      assertRecognizedDatabase(db, actual)
      // Apply mutating pragmas only after refusing foreign or canonical files.
      // journalMode is a validated closed union, not caller-controlled SQL.
      db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
      ensurePersistentSchema(db)
      ensureTemporarySchema(db)
      return { db, release: () => ownership.release() }
    } catch (error: unknown) {
      db.close()
      throw error
    }
  } catch (error: unknown) {
    await ownership.release()
    throw error
  }
}

function assertRecognizedDatabase(db: DatabaseSync, actual: string): void {
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const userTables = listUserTables(db)
  if (applicationId !== 0 && applicationId !== SESSION_QUERY_SQLITE_APPLICATION_ID) {
    throw new Error(`session-search database at "${actual}" belongs to another application`)
  }
  if (applicationId === 0 && userTables.length > 0) {
    throw new Error(`session-search database at "${actual}" is not an empty or recognized derived index`)
  }
  if (applicationId === SESSION_QUERY_SQLITE_APPLICATION_ID) {
    assertDerivedUserTables(actual, userTables)
    if (version !== SESSION_QUERY_SQLITE_SCHEMA_VERSION) resetDerivedSchema(db, userTables)
  }
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function assertDerivedUserTables(path: string, userTables: readonly string[]): void {
  const unknownTables = userTables.filter(name => !DERIVED_USER_TABLES.has(name))
  if (unknownTables.length > 0) {
    throw new Error(
      `session-search database at "${path}" has unrecognized user tables: ${unknownTables.join(', ')}`,
    )
  }
}

function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[]): void {
  for (const name of userTables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`)
  }
  db.exec('PRAGMA user_version = 0')
}

function ensurePersistentSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_state (
      singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `)
  db.exec('INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS persisted_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      revision       TEXT NOT NULL,
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
  // Sources known from a completed listing that are not searchable yet: covered
  // by a live owner, awaiting a read, or failed. Rows remain invisible to MATCH.
  // `seeded` carries the listed header's fork flag; the exact inherited cut is
  // only known after the read, so a committed row stores it instead.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seeded         INTEGER NOT NULL CHECK (seeded IN (0, 1)),
      delegation_depth INTEGER,
      agent_preset   TEXT,
      revision       TEXT NOT NULL,
      state          TEXT NOT NULL CHECK (state IN ('live', 'pending', 'failed')),
      attempts       INTEGER NOT NULL,
      error          TEXT,
      observed_at    INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION}`)
}

function ensureTemporarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS live_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      fingerprint    TEXT NOT NULL,
      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.live_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
