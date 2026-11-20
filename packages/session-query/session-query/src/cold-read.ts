/** One-shot cold session read through the handle-based persistence seam. */

import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandleReadResult, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'

/** A stored session log balanced for read-only viewing. */
export interface ColdSessionLog {
  /** Aliasing state of the persisted events; synthetic closers are locally owned. */
  readonly eventState: SessionSeedEventState
  /** The stored header, fixed when the read handle opened. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffset
  /** Stored events plus deterministic in-memory closers for an interrupted final turn; nothing is written back. */
  readonly events: SessionEvent[]
  /**
   * Number of leading {@link events} that came from the stored read. The
   * remaining entries are locally synthesized interrupted-turn closers and
   * must never be folded into a durable checkpoint.
   */
  readonly storedEventCount: number
}

/** One stored prefix observed while the backing artifact revision held still. */
export interface StableColdLog extends ColdSessionLog {
  /** Durable change token observed before and after the stored read. */
  readonly revision: SessionPersistenceRevision
}

/**
 * Read one complete stored session log without taking ownership or mutating
 * storage: open a read handle, read the validated contiguous log, close the
 * handle, and append `interruptedTurnClosers` so a log whose writer crashed
 * mid-turn folds as a balanced transcript. Backend failures propagate
 * unmapped — each caller owns its error taxonomy.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the stored session to read.
 * @param signal - optional cancellation for the open and read work.
 * @returns an adoptable seed in a caller-owned outer array, ready for in-place Session restoration.
 */
export async function readColdSessionLog(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await persistence.open(sessionId, 'read', options)
  let read: SessionHandleReadResult
  try {
    read = await handle.read(0, undefined, options)
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // The read failure is the actionable cause; a close failure on the same broken handle adds nothing.
    }
    throw error
  }
  await handle.close()
  const { events } = read
  return {
    eventState: read.eventState,
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
    storedEventCount: events.length,
  }
}

/**
 * Read one cold log only while its stored artifact is demonstrably unchanged.
 *
 * The snapshot's revision is taken before the read and rechecked after it; a
 * changed artifact (a concurrent append, migration publication, crash repair,
 * or removal) returns `undefined` instead of a mixed-cut prefix. Only a
 * current-format, non-empty snapshot is accepted; a session that is pending,
 * migration-required, or absent has no durable prefix a checkpoint may claim.
 *
 * The returned {@link StableColdLog} still carries the in-memory closers in
 * `events`; consumers that persist a checkpoint must use the leading
 * {@link ColdSessionLog.storedEventCount} entries. This function proves the
 * read was quiescent, not that the store makes every observed append durable;
 * the caller owns that backend contract.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the stored session to read.
 * @param signal - optional cancellation for both snapshots and the read.
 * @returns the stable stored prefix, or `undefined` when no durable prefix is provable.
 */
export async function readStableColdLog(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<StableColdLog | undefined> {
  const options = signal === undefined ? undefined : { signal }
  const before = await persistence.stat(sessionId, options)
  if (before === undefined || before.formatStatus !== 'current') return undefined
  const log = await readColdSessionLog(persistence, sessionId, signal)
  const after = await persistence.stat(sessionId, options)
  if (after === undefined || after.revision !== before.revision) return undefined
  if (log.inheritedEventCount > log.storedEventCount) return undefined
  return { ...log, revision: before.revision }
}
