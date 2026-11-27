/** Web opening aggregation over one observation and a shared transforming buffer. */

import type { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { HistoryController } from '../history/controller.ts'
import { addressId, rejectNotFound } from '../history.ts'
import { EventListener, ListenerBuffer } from '../history/listener.ts'
import { history, projections, resolveHistoryRequest, validateObservationAddress } from '../history/controller.ts'
import type { SessionFollowFrame, SessionFollowRequest } from '../types.ts'

/** Combines opening data and consumes transformed listener output from one queue. */
export class WebController {

  /**
   * @param ctx - Host context carrying Session queries and identity projections.
   * @param historyController - passive reading and listener construction.
   * @param promote - background activation using a retained full observation.
   * @param promoteIndexed - admit background activation by id after an indexed opening.
   */
  constructor(
    private readonly ctx: Context,
    private readonly historyController: HistoryController,
    private readonly promote: (observation: SessionObservation) => void,
    private readonly promoteIndexed?: (sessionId: SessionId) => void,
  ) {}

  /**
   * Open a history snapshot and follow uncovered history and assistant notifications.
   * @param request - Session identity, page budget, assistant output and optional activation (default false).
   * @param signal - cancellation for opening and streaming.
   * @returns an opening snapshot followed by uncovered queued increments.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const sessionId = addressId(request.address)
    const spec = resolveHistoryRequest(request)
    using queue = new ListenerBuffer<SessionFollowFrame>(this.ctx, signal)
    using listener = new EventListener(this.ctx, sessionId, signal, queue)
    const streams = this.historyController.streamsListener
    using assistantListener = request.assistantStream === true
      ? streams.bind(sessionId, signal, queue)
      : undefined
    const indexedRequest = { ...request, maxMessages: spec.maxMessages }
    const indexed = request.address.kind === 'session' && this.ctx.sessions.get(sessionId) === undefined
      ? await this.historyController.indexedOpening(indexedRequest, signal)
      : undefined
    signal.throwIfAborted()
    const source = indexed !== undefined && indexed.header.id === sessionId && indexed.header.cwd !== undefined
      && indexed.header.origin !== 'subagent' && this.ctx.sessions.get(sessionId) === undefined
      ? { kind: 'indexed' as const, indexed }
      : {
        kind: 'observed' as const,
        observation: await this.historyController.usingObservation({ sessionId, projection: true }, signal)
          .catch((error: unknown) => {
            if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
            throw error
          }),
      }
    using observation = source.observation
    signal.throwIfAborted()
    let opening: Extract<SessionFollowFrame, { type: 'snapshot' }>
    if (source.kind === 'indexed') {
      opening = { type: 'snapshot', ...source.indexed }
    } else {
      validateObservationAddress(request.address, source.observation)
      opening = {
        type: 'snapshot',
        header: { ...source.observation.header },
        projections: projections(source.observation),
        ...history(source.observation, spec),
      }
    }
    listener.setCursor(opening.cursor)
    if (assistantListener !== undefined) {
      const { baseline: assistantStream, ordinal } = assistantListener.snapshot()
      opening = { ...opening, assistantStream }
      assistantListener.setOrdinalCut(ordinal)
    }
    // Admit activation before yielding so a snapshot-only reader still gets it.
    if (source.kind === 'indexed') {
      if (request.activate === true) this.promoteIndexed?.(sessionId)
    } else {
      const observed = source.observation
      const canPromote = observed.source === 'prepared' && observed.header.origin !== 'subagent'
      if (canPromote) this.historyController.rememberOpening(observed, indexedRequest, opening)
      const promotion = canPromote && request.activate === true && !signal.aborted ? observed.retain() : undefined
      // Increments come from the queue, so the opening ends the observation lease.
      observation?.[Symbol.dispose]()
      if (promotion !== undefined) {
        try {
          this.promote(promotion)
        } catch (error: unknown) {
          promotion[Symbol.dispose]()
          throw error
        }
      }
    }
    yield opening
    yield* queue.items()
  }
}
