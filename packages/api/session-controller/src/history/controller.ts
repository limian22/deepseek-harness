/** Independent Session snapshots and passive event subscriptions. */

import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionObservation, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import {
  DEFAULT_MAX_MESSAGES, paginate, pageRecords, entryFor, addressId,
  validateHistoryWindow, validateAddress, rejectNotFound,
} from '../history.ts'
import { EventListener, ProjectionListener } from './listener.ts'
import { SessionAssistantStreamsListener } from './assistant-stream.ts'
import type {
  SessionEventFrame, SessionEventsPage, SessionFollowFrame, SessionFollowRequest, SessionPageRequest,
  SessionObserveEventRequest, SessionProjectionsRequest, SessionProjectionFrame,
  SessionAddress, SessionProjectionBaseline, SessionProjectionValues, SessionProjectionsValue, SessionWaitOutput, SessionHistoryRecord,
} from '../types.ts'

interface ObservationRequest {
  readonly sessionId: SessionId
  readonly projection: boolean
  readonly cachePrepared?: false
}

type OpeningSnapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>
type OpeningRequest = SessionFollowRequest & Pick<SessionPageRequest, 'beforeSeq' | 'throughSeq'> & { readonly maxMessages: number }

const INDEX_WINDOW = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
const MIN_BACKFILL_BYTES = 512 * 1024

function indexable(request: OpeningRequest): boolean {
  return request.address.kind === 'session' && request.beforeSeq === undefined && request.throughSeq === undefined
    && request.maxMessages === INDEX_WINDOW.maxMessages
    && request.turnWindow?.minMessages === INDEX_WINDOW.turnWindow.minMessages
    && request.turnWindow.minTurns === INDEX_WINDOW.turnWindow.minTurns
}

/** Session snapshots do not share lifetime with passive subscriptions. */
export class HistoryController {

  /** Reconnect state for this controller's assistant subscriptions. */
  readonly streamsListener: SessionAssistantStreamsListener
  private readonly catalogQueue = new Map<SessionId, () => Promise<void>>()
  private readonly unindexedRevision = new Map<SessionId, string>()
  private readonly indexLifetime = new AbortController()
  private indexing = false

  /** @param ctx - Host context carrying Session reads and projections. */
  constructor(private readonly ctx: Context) {
    this.streamsListener = new SessionAssistantStreamsListener(this.ctx)
    this.ctx.effect(() => () => { this.indexLifetime.abort() }, 'session-history.opening-index')
  }

  /** Read a cold opening only when persistence and all current projection units accept its receipt. */
  async indexedOpening(request: OpeningRequest, signal: AbortSignal): Promise<Omit<OpeningSnapshot, 'type' | 'assistantStream'> | undefined> {
    if (!indexable(request)) return undefined
    const id = addressId(request.address)
    const persistence = this.ctx.get('sessionPersistence')
    const cache = this.ctx.get('sessionProjectionCache')
    if (persistence?.readOpening === undefined || cache?.hasOpening(id) !== true
      || this.ctx.sessions.get(id) !== undefined) return undefined
    let attached = false
    const hasAttached = () => attached
    const detach = this.ctx.on('session/created', (session) => { if (session.id === id) attached = true }, { global: true })
    try {
      const source = await persistence.stat(id, { signal })
      if (source === undefined || source.header.id !== id || source.header.cwd === undefined
        || source.header.isSeeded || source.header.origin === 'subagent' || hasAttached()) return undefined
      const receipt = cache.openingReceipt(source.header)
      if (receipt === undefined || receipt.revision !== source.revision) return undefined
      const events = await persistence.readOpening(source, receipt, signal)
      signal.throwIfAborted()
      if (events === undefined || hasAttached() || this.ctx.sessions.get(id) !== undefined
        || this.ctx.get('sessionPersistence')?.identity !== persistence.identity) return undefined
      const current = this.ctx.get('sessionProjectionCache')?.cachedOpening(source.header)
      if (current?.receipt !== receipt) return undefined
      const cursor = SessionSeq(receipt.cursor)
      const page = paginate(events, undefined, request.maxMessages, cursor, request.turnWindow, SessionLogOffset(receipt.firstSeq))
      if (page.needsEarlier === true) return undefined
      return {
        header: source.header, cursor, records: pageRecords(page.events), hasMore: page.hasMore,
        projections: current.projections as SessionProjectionBaseline,
      }
    } catch {
      signal.throwIfAborted()
      return undefined
    } finally {
      detach()
    }
  }

  /** Prepare a future indexed opening from a fully restored ordinary session. */
  rememberOpening(observation: SessionObservation, request: OpeningRequest, opening: OpeningSnapshot): void {
    if (!indexable(request) || observation.source !== 'prepared' || !opening.hasMore
      || observation.header.isSeeded || observation.header.origin === 'subagent'
      || observation.persistedEventCount !== observation.cursor + 1 || observation.revision === undefined) return
    const firstSeq = opening.records[0]?.event.seq
    if (firstSeq === undefined || firstSeq === 0) return
    if (!this.canIndex()) return
    const id = observation.header.id
    if (!this.catalogQueue.has(id)) this.catalogQueue.set(id, () => this.writeOpening(observation, firstSeq))
    this.startIndexing()
  }

  /** Schedule one bounded background lane for long, current, ordinary session logs. */
  indexCatalog(records: readonly SessionRecord[]): void {
    const cache = this.ctx.get('sessionProjectionCache')
    if (cache === undefined || !this.canIndex()) return
    for (const { header, formatStatus, sizeBytes, revision } of records) {
      if (formatStatus === 'current' && revision !== undefined && (sizeBytes ?? 0) >= MIN_BACKFILL_BYTES
        && header.origin !== 'subagent' && !header.isSeeded && this.unindexedRevision.get(header.id) !== revision
        && !this.catalogQueue.has(header.id)
        && !cache.hasOpening(header.id, revision)) {
        this.catalogQueue.set(header.id, () => this.buildCatalogOpening(header.id))
      }
    }
    this.startIndexing()
  }

  private canIndex(): boolean {
    return !this.indexLifetime.signal.aborted && this.ctx.get('sessionProjectionCache') !== undefined
      && this.ctx.get('sessionPersistence')?.supportsOpeningIndex?.() === true
  }

  private startIndexing(): void {
    if (this.indexing || this.catalogQueue.size === 0 || !this.canIndex()) return
    this.indexing = true
    void this.drainOpeningIndex().finally(() => { this.indexing = false })
  }

  private async drainOpeningIndex(): Promise<void> {
    for (const [id, build] of this.catalogQueue) {
      await scheduler.yield()
      if (!this.canIndex()) break
      try {
        if (this.ctx.sessions.get(id) === undefined) await build()
      } catch {
        // A failed or superseded index must not affect the authority of the stored log.
      } finally {
        this.catalogQueue.delete(id)
      }
    }
    this.catalogQueue.clear()
  }

  private async buildCatalogOpening(id: SessionId): Promise<void> {
    const signal = this.indexLifetime.signal
    using observation = await this.usingObservation({ sessionId: id, projection: false, cachePrepared: false }, signal)
    if (observation.source !== 'prepared' || observation.revision === undefined) return
    const page = history(observation, INDEX_WINDOW)
    const firstSeq = page.records[0]?.event.seq
    if (!page.hasMore || firstSeq === undefined || observation.persistedEventCount !== observation.cursor + 1) {
      this.unindexedRevision.set(id, observation.revision)
      return
    }
    await this.writeOpening(observation, firstSeq)
  }

  private async writeOpening(observation: SessionObservation, firstSeq: number): Promise<void> {
    const signal = this.indexLifetime.signal
    const persistence = this.ctx.get('sessionPersistence')
    const cache = this.ctx.get('sessionProjectionCache')
    const { header, events, revision } = observation
    if (signal.aborted || persistence?.describeOpening === undefined || cache === undefined
      || this.ctx.sessions.get(header.id) !== undefined) return
    const source = await persistence.stat(header.id, { signal })
    if (source === undefined || source.revision !== revision) return
    const receipt = await persistence.describeOpening(source, events, firstSeq, signal)
    if (receipt === undefined) return
    await cache.writeOpening(header, { ...receipt, revision: source.revision, version: 1 }, events, async () =>
      !signal.aborted && this.ctx.get('sessionPersistence')?.identity === persistence.identity
      && (await persistence.stat(header.id, { signal }))?.revision === source.revision)
  }

  /**
   * Read a passive page of Session events at an exact cut.
   * @param request - Session identity and optional cut and page window.
   * @param signal - read cancellation.
   * @returns a page at the supplied cut, or the observed log end when omitted.
   */
  async events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage> {
    const spec = resolveHistoryRequest(request)
    try {
      return await this.usingObservation({ sessionId: addressId(request.address), projection: request.address.kind === 'subagent' }, signal, (observation) => {
        validateObservationAddress(request.address, observation)
        return history(observation, spec)
      })
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
      throw error
    }
  }

  /**
   * Subscribe to Session events without reading or activating the Session.
   * @param request - Session address to subscribe.
   * @param signal - stream cancellation.
   * @returns subscription readiness followed by event frames; readiness does not establish existence.
   */
  async *observeEvent(request: SessionObserveEventRequest, signal: AbortSignal): AsyncIterable<SessionEventFrame> {
    using listener = new EventListener(this.ctx, addressId(request.address), signal)
    yield { type: 'ready' }
    yield* listener.events()
  }

  /**
   * Read exact projections or migration cache hints without activating the Session.
   * @param request - Session identity whose exact projection baseline is required.
   * @param signal - read cancellation.
   * @returns exact sequenced values, migration cache hints, or null when absent.
   */
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    const { sessionId } = request
    if (sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    }
    try {
      signal.throwIfAborted()
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) {
        const snapshot = this.ctx.sessionProjections.snapshot(live)
        return { kind: 'sequenced', asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
      } else {
        const stored = await this.ctx.get('sessionPersistence')?.stat(sessionId, { signal })
        signal.throwIfAborted()
        if (stored?.formatStatus === 'migration-required') {
          const cached = this.ctx.get('sessionProjectionCache')?.cachedSnapshot(stored.header)
          return { kind: 'migration-required', values: { ...cached?.values } as SessionProjectionValues }
        }
        return await this.usingObservation({ sessionId: request.sessionId, projection: true }, signal, observation => ({
          kind: 'sequenced' as const,
          ...projections(observation),
        }))
      }
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found') {
        return null
      }
      if (signal.aborted || code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  /**
   * Subscribe to projection changes without reading a baseline.
   * @param request - Session identity to subscribe without reading a baseline.
   * @param signal - stream cancellation.
   * @returns readiness followed by one change frame per committed event, listing every key it changed.
   */
  async *observeProjections(request: SessionProjectionsRequest, signal: AbortSignal): AsyncIterable<SessionProjectionFrame> {
    using listener = new ProjectionListener(this.ctx, request.sessionId, signal)
    yield { type: 'ready' }
    yield* listener.changes()
  }

  /**
   * Read bounded committed assistant messages through a stopping cursor.
   * @param sessionId - Session whose committed assistant messages are requested.
   * @param afterSeq - exclusive lower bound.
   * @param throughSeq - inclusive stopping-state cursor.
   * @param maxMessages - positive assistant record limit.
   * @param signal - caller cancellation, independent of a completed wait deadline.
   * @returns newest-first assistant messages and whether further matching records were omitted.
   */
  async assistantOutput(
    sessionId: SessionId, afterSeq: number, throughSeq: number, maxMessages: number, signal: AbortSignal,
  ): Promise<SessionWaitOutput> {
    return this.usingObservation({ sessionId, projection: false }, signal, (observation) => {
      if (throughSeq > observation.cursor) {
        throw new RemoteError('gateway/internal', 'Session history no longer covers the wait cursor', {})
      }
      const records: SessionHistoryRecord[] = []
      const events = observation.events
      for (let index = throughSeq; index > afterSeq; index--) {
        const event = events[index] as SessionEvent
        if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
        if (records.length === maxMessages) return { records, truncated: true }
        records.push(entryFor(event))
      }
      return { records, truncated: false }
    })
  }

  /**
   * Acquire a read without activating a Session; projections are opt-in.
   * @param request - Session identity and whether to compute projections.
   * @param signal - read cancellation.
   * @param callback - omitted to transfer lease ownership to the caller.
   * @returns a lease the caller must dispose.
   */
  usingObservation(
    request: ObservationRequest, signal: AbortSignal, callback?: undefined,
  ): Promise<SessionObservation>
  /**
   * Keep the borrowed lease alive until the callback settles, then dispose it.
   * @param request - Session identity and whether to compute projections.
   * @param signal - read cancellation.
   * @param callback - synchronous or asynchronous computation; retain a separate lease if it must escape.
   * @returns the callback result; read and callback failures propagate.
   */
  usingObservation<T>(
    request: ObservationRequest, signal: AbortSignal,
    callback: (observation: SessionObservation) => T,
  ): Promise<Awaited<T>>
  async usingObservation<T>(
    { sessionId, projection, cachePrepared }: ObservationRequest,
    signal: AbortSignal,
    callback?: (observation: SessionObservation) => T,
  ): Promise<SessionObservation | Awaited<T>> {
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        signal, projectionMode: projection ? 'all' : 'none', ...(cachePrepared === undefined ? {} : { cachePrepared }),
      })
    } catch (error: unknown) {
      const code = (error as { readonly code?: unknown } | null | undefined)?.code
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      if (code === 'SESSION_QUERY_ABORTED') {
        // Keep the query's own message: cancellation detail was visible before this mapping.
        throw new RemoteError('gateway/cancelled',
          error instanceof Error ? error.message : 'Session read was cancelled', {}, { cause: error })
      }
      throw error
    }
    try {
      signal.throwIfAborted()
    } catch (error: unknown) {
      observation[Symbol.dispose]()
      throw error
    }
    if (callback === undefined) return observation
    using ownedObservation = observation
    return await callback(ownedObservation)
  }
}

/**
 * Validate an Address against the exact read used by a Controller.
 * @param address - caller-supplied Session address.
 * @param observation - borrowed read; subagent addresses require projections.
 */
export function validateObservationAddress(address: SessionAddress, observation: SessionObservation): void {
  if (observation.header.cwd === undefined) rejectNotFound(address)
  validateAddress(address, observation.header, observation.inheritedEventCount, observation.projections)
}

/**
 * Convert a borrowed observation to one page without acquiring or retaining it.
 * @param observation - exact read cut owned by the caller.
 * @param request - validated page window and optional inclusive cut.
 * @returns a chronological page at the requested cut.
 */
export function history(observation: SessionObservation, request: Omit<SessionPageRequest, 'address'> & { readonly maxMessages: number }): SessionEventsPage {
  const cursor = request.throughSeq === undefined ? observation.cursor
    : request.throughSeq === -1 ? -1 : SessionSeq(request.throughSeq)
  if (cursor > observation.cursor) {
    throw new RemoteError('gateway/bad-request', `session history cut ${String(cursor)} exceeds ${String(observation.cursor)}`, {})
  }
  const page = paginate(
    observation.events,
    request.beforeSeq === undefined ? undefined : SessionLogOffset(request.beforeSeq),
    request.maxMessages,
    cursor,
    request.turnWindow,
  )
  return { cursor, records: pageRecords(page.events), hasMore: page.hasMore }
}

/**
 * Convert the projection baseline without acquiring or retaining its observation.
 * @param observation - projected read cut owned by the caller.
 * @returns the exact baseline; missing projection support fails explicitly.
 */
export function projections(observation: SessionObservation): SessionProjectionBaseline {
  const snapshot = observation.projections
  if (snapshot === undefined) throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
  return { asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
}

/**
 * Validate and resolve the history page window.
 * @param request - external history window.
 * @returns the validated request with an explicit message budget.
 */
export function resolveHistoryRequest(request: SessionPageRequest): SessionPageRequest & { readonly maxMessages: number } {
  if (request.throughSeq !== undefined
    && (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1 || Object.is(request.throughSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  validateHistoryWindow(request)
  return { ...request, maxMessages: request.maxMessages ?? DEFAULT_MAX_MESSAGES }
}
