/**
 * Main-thread owner of the JSONL read worker: one lazily spawned, long-lived
 * Worker Thread and a bounded single-flight queue. It carries only detached
 * validated read results back; the worker itself owns the decode and the
 * read-only persistence handle, so this module never parses session bytes.
 * @module
 */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceRevision as PersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { JsonlCompression } from './format.ts'
import {
  parseReadWorkerMessage,
  type ReadLogRequest,
  type ReadLogResponse,
  type ReadWorkerConfig,
} from './read-worker-protocol.ts'

/**
 * How many newer source revisions one cold read tries before handing the read
 * to the existing in-process stable-read path. A continuously appending writer
 * must not starve the open; every other worker failure surfaces to the caller.
 */
export const READ_WORKER_SOURCE_CHANGE_ATTEMPTS = 3

/** One detached current log decoded and validated by the worker. */
export interface ReadLogWorkerResult {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: SessionEvent[]
  readonly revision: PersistenceRevision
}

/** Worker transport, startup, or protocol failure; the caller isolates the affected session. */
export class JsonlReadWorkerFailureError extends Error {
  override name = 'JsonlReadWorkerFailureError'
}

/** The worker decoded a different revision than the caller selected. */
export class JsonlReadWorkerSourceChangedError extends Error {
  override name = 'JsonlReadWorkerSourceChangedError'
}

/** The worker decoded the selected revision but its provider rejected the log. */
export class JsonlReadWorkerDecodeError extends Error {
  override name = 'JsonlReadWorkerDecodeError'

  /**
   * @param errorName - the backend error class name observed in the worker.
   * @param message - the worker's complete backend diagnostic.
   * @param errorCode - a filesystem errno carried by the worker, when any.
   * @param options - the original error as the cause.
   */
  constructor(
    readonly errorName: string,
    message: string,
    readonly errorCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** One queued or in-flight cold read. */
interface QueuedRead {
  readonly request: ReadLogRequest
  readonly settled: PromiseWithResolvers<ReadLogWorkerResult>
  detachAbort: (() => void) | undefined
  /** The waiter stopped waiting; a response that still arrives is discarded. */
  cancelled: boolean
}

/** Configuration shared by one backend instance's read worker. */
export interface JsonlReadWorkerClientOptions {
  readonly root: string
  readonly compression: JsonlCompression
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('read worker request aborted', { cause: signal.reason })
}

/** Abandoned-worker termination failures must not replace the reported failure. */
function ignoreTerminationFailure(termination: unknown): void {
  void termination
}

/** Resolve the Worker entry: bundled CJS from built output, TypeScript through tsx from source. */
function readWorkerEntry(config: ReadWorkerConfig): { readonly entry: string | URL; readonly options: WorkerOptions } {
  /* v8 ignore next 4 -- built-worker coverage owns the bundled path. */
  if (!import.meta.url.endsWith('.ts')) {
    return { entry: new URL('./read-worker.cjs', import.meta.url), options: { workerData: config, execArgv: [] } }
  }
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(new URL('./read-worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: { workerData: config, execArgv: [] },
  }
}

/**
 * Own the backend's read worker. Callers enqueue at most one cold open each;
 * one request executes in the worker at a time, and a cancelled waiter never
 * cancels the request another caller may share the worker with.
 */
export class JsonlReadWorkerClient {
  private readonly config: ReadWorkerConfig
  private readonly queue: QueuedRead[] = []
  private active: QueuedRead | undefined
  private worker: Worker | undefined
  private workerReady = false
  private booting: PromiseWithResolvers<void> | undefined
  private pumpScheduled = false
  private disposed: Promise<void> | undefined
  private sequence = 0

  /** @param options - the backend root and physical encoding the worker must reuse. */
  constructor(options: JsonlReadWorkerClientOptions) {
    this.config = { root: options.root, compression: options.compression }
  }

  /**
   * Decode one selected current generation in the worker.
   * @param request - session id, selected artifact path, and its stat-derived revision.
   * @param signal - caller cancellation; stops only this waiter.
   * @returns the detached header, inherited count, events, and verified revision.
   * @throws {JsonlReadWorkerFailureError} when the worker cannot start, accept, or answer.
   * @throws {JsonlReadWorkerSourceChangedError} when the source no longer matches the revision.
   * @throws {JsonlReadWorkerDecodeError} when the worker's provider rejected the log.
   * @throws the signal reason when the waiter is cancelled.
   */
  read(
    request: { readonly id: SessionId; readonly path: string; readonly revision: PersistenceRevision },
    signal?: AbortSignal,
  ): Promise<ReadLogWorkerResult> {
    if (this.disposed !== undefined) {
      return Promise.reject(new JsonlReadWorkerFailureError('JSONL read worker client is disposed'))
    }
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    this.sequence += 1
    const queued: QueuedRead = {
      request: { request: this.sequence, id: request.id, path: request.path, revision: request.revision },
      settled: Promise.withResolvers<ReadLogWorkerResult>(),
      detachAbort: undefined,
      cancelled: false,
    }
    if (signal !== undefined) {
      const abort = (): void => { this.cancel(queued, signal) }
      signal.addEventListener('abort', abort, { once: true })
      queued.detachAbort = () => { signal.removeEventListener('abort', abort) }
    }
    this.queue.push(queued)
    this.schedulePump()
    return queued.settled.promise
  }

  /**
   * Terminate the worker and reject every outstanding read. Idempotent.
   * @returns resolution after the worker has terminated.
   */
  dispose(): Promise<void> {
    this.disposed ??= this.shutdown()
    return this.disposed
  }

  private async shutdown(): Promise<void> {
    const failure = new JsonlReadWorkerFailureError('JSONL read worker client is disposed')
    const active = this.active
    this.active = undefined
    for (const queued of this.queue.splice(0)) this.settle(queued, failure)
    if (active !== undefined) this.settle(active, failure)
    this.booting?.reject(failure)
    this.booting = undefined
    const worker = this.worker
    this.worker = undefined
    this.workerReady = false
    if (worker === undefined) return
    try {
      await worker.terminate()
    } catch (error: unknown) {
      /* v8 ignore next 2 -- terminate rejects only after the worker stopped; its exit already settled every read. */
      throw new AggregateError([failure, asError(error)], 'JSONL read worker termination failed')
    }
  }

  private cancel(queued: QueuedRead, signal: AbortSignal): void {
    /* v8 ignore next -- an abort listener fires once for its signal; a duplicate cancel is unreachable. */
    if (queued.cancelled) return
    queued.cancelled = true
    const queuedIndex = this.queue.indexOf(queued)
    if (queuedIndex !== -1) this.queue.splice(queuedIndex, 1)
    // An in-flight request keeps its slot until the worker answers, because the
    // worker protocol carries one response for one posted request. The result is
    // discarded on arrival; the waiter itself stops now.
    queued.detachAbort?.()
    queued.settled.reject(abortReason(signal))
  }

  private settle(queued: QueuedRead, outcome: ReadLogWorkerResult | Error): void {
    queued.detachAbort?.()
    if (queued.cancelled) return
    if (outcome instanceof Error) {
      queued.settled.reject(outcome)
      return
    }
    queued.settled.resolve(outcome)
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      while (this.disposed === undefined && this.active === undefined && this.queue.length > 0) {
        const queued = this.queue.shift()
        /* v8 ignore next -- the loop condition proves an entry remains. */
        if (queued === undefined) return
        if (queued.cancelled) continue
        if (!this.workerReady) {
          try {
            await this.ensureWorker()
          } catch (error: unknown) {
            this.settle(queued, this.failure(error))
            this.failWorker(this.worker, error)
            continue
          }
        }
        // The waiter may have given up while the worker was starting.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- The abort listener mutates this while ensureWorker is awaited.
        if (queued.cancelled) continue
        const worker = this.worker
        /* v8 ignore next 4 -- ensureWorker resolves only after the worker reference is live. */
        if (worker === undefined) {
          this.settle(queued, new JsonlReadWorkerFailureError('JSONL read worker became unavailable'))
          continue
        }
        /* v8 ignore next 4 -- a disposal microtask can win the race before this continuation resumes. */
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can settle while ensureWorker is awaited.
        if (this.disposed !== undefined) {
          this.settle(queued, new JsonlReadWorkerFailureError('JSONL read worker client is disposed'))
          continue
        }
        this.active = queued
        try {
          worker.postMessage(queued.request)
        } catch (error: unknown) {
          this.active = undefined
          this.settle(queued, this.failure(error))
          this.failWorker(worker, error)
        }
      }
    } finally {
      this.pumpScheduled = false
      if (this.disposed === undefined && this.active === undefined && this.queue.length > 0) this.schedulePump()
    }
  }

  private ensureWorker(): Promise<void> {
    this.booting ??= this.boot()
    return this.booting.promise
  }

  private boot(): PromiseWithResolvers<void> {
    const { entry, options } = readWorkerEntry(this.config)
    const worker = new Worker(entry, options)
    this.worker = worker
    this.workerReady = false
    const ready = Promise.withResolvers<void>()
    worker.on('message', (value: unknown) => { this.onWorkerMessage(worker, value, ready) })
    worker.on('error', (error: Error) => { this.failWorker(worker, error, ready) })
    worker.on('exit', (code: number) => {
      this.failWorker(worker, new JsonlReadWorkerFailureError(`JSONL read worker exited (code ${String(code)})`), ready)
    })
    return ready
  }

  private onWorkerMessage(worker: Worker, value: unknown, booting?: PromiseWithResolvers<void>): void {
    /* v8 ignore next -- a replaced or disposed worker's late message has no outstanding waiter. */
    if (this.worker !== worker || this.disposed !== undefined) return
    let message: ReturnType<typeof parseReadWorkerMessage>
    try {
      message = parseReadWorkerMessage(value)
    } catch (error: unknown) {
      this.failWorker(worker, error, booting)
      return
    }
    if (!this.workerReady) {
      if (message.kind === 'ready') {
        this.workerReady = true
        this.booting = undefined
        booting?.resolve()
        this.schedulePump()
        return
      }
      this.failWorker(worker, message.kind === 'failed'
        ? new JsonlReadWorkerFailureError(`JSONL read worker failed to start: ${message.message}`)
        : new JsonlReadWorkerFailureError('JSONL read worker answered before it was ready'), booting)
      return
    }
    if (message.kind !== 'response') {
      this.failWorker(worker, new JsonlReadWorkerFailureError('JSONL read worker sent an unexpected lifecycle message'))
      return
    }
    this.settleResponse(worker, message.response)
  }

  private settleResponse(worker: Worker, response: ReadLogResponse): void {
    const queued = this.active
    if (queued === undefined) {
      this.failWorker(worker, new JsonlReadWorkerFailureError('JSONL read worker answered without a pending request'))
      return
    }
    this.active = undefined
    if (response.request !== queued.request.request) {
      this.settle(queued, new JsonlReadWorkerFailureError('JSONL read worker answered a different request'))
      this.failWorker(worker, new JsonlReadWorkerFailureError('JSONL read worker answered a different request'))
      return
    }
    if (response.ok) {
      if (response.revision !== queued.request.revision) {
        const failure = new JsonlReadWorkerFailureError('JSONL read worker returned a different revision')
        this.settle(queued, failure)
        this.failWorker(worker, failure)
        return
      }
      this.settle(queued, {
        header: response.header,
        inheritedEventCount: response.inheritedEventCount,
        events: [...response.events],
        revision: SessionPersistenceRevision(response.revision),
      })
      this.schedulePump()
      return
    }
    switch (response.code) {
      case 'source-changed':
        this.settle(queued, new JsonlReadWorkerSourceChangedError(
          `session "${queued.request.id}" changed while the read worker decoded it`,
        ))
        this.schedulePump()
        return
      case 'decode-error': {
        const cause = new Error(response.message)
        if (response.stack !== undefined) cause.stack = response.stack
        if (response.errorCode !== undefined) (cause as NodeJS.ErrnoException).code = response.errorCode
        this.settle(queued, new JsonlReadWorkerDecodeError(response.name, response.message, response.errorCode, { cause }))
        this.schedulePump()
      }
    }
  }

  private failure(cause: unknown): JsonlReadWorkerFailureError {
    if (cause instanceof JsonlReadWorkerFailureError) return cause
    const error = asError(cause)
    return new JsonlReadWorkerFailureError(`JSONL read worker failed: ${errorChain(cause)}`, { cause: error })
  }

  /** Abandon the current worker, fail every outstanding read, and allow a later respawn. */
  private failWorker(worker: Worker | undefined, cause: unknown, booting?: PromiseWithResolvers<void>): void {
    /* v8 ignore next 4 -- a disposed client reports shutdown once; late terminal events add nothing. */
    if (this.disposed !== undefined) {
      booting?.reject(this.failure(cause))
      return
    }
    /* v8 ignore next -- only the owned worker reports terminal events; a stale one is already abandoned. */
    if (worker !== undefined && this.worker !== undefined && this.worker !== worker) return
    const failure = this.failure(cause)
    this.worker = undefined
    this.workerReady = false
    this.booting = undefined
    booting?.reject(failure)
    const active = this.active
    this.active = undefined
    if (active !== undefined) this.settle(active, failure)
    for (const queued of this.queue.splice(0)) this.settle(queued, failure)
    const owned = worker ?? undefined
    if (owned !== undefined) void owned.terminate().catch(ignoreTerminationFailure)
  }
}
