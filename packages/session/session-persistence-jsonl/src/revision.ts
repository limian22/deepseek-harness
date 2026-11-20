/**
 * Physical revision tokens shared by the JSONL backend and its read worker. A
 * token combines the stat identity of one file revision; equal tokens mean the
 * bytes may be treated as unchanged, and unequal tokens promise nothing.
 * @module
 */

import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceRevision as PersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { JsonlPhysicalIdentity } from './generation.ts'

/**
 * Build the stat-derived best-effort change token shared by full and lightweight reads.
 * @param identity - the file's bigint stat identity.
 * @returns an opaque revision token comparable only for the same path.
 */
export function fileRevision(identity: JsonlPhysicalIdentity): PersistenceRevision {
  return SessionPersistenceRevision([
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join(':'))
}
