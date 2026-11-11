/**
 * Worker entry for JSONL cold reads. It boots one provider instance over the
 * configured root (with worker offloading disabled, so it cannot recurse),
 * answers a readiness handshake, and decodes each requested current generation
 * through the provider's own read-only handle. It never opens a write handle,
 * never publishes a migration, and never writes an artifact.
 */

import { stat } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from './index.ts'
import { generationLogPath } from './format.ts'
import { fileRevision } from './revision.ts'
import { parseReadLogRequest, parseReadWorkerConfig } from './read-worker-protocol.ts'
import type { ReadLogRequest, ReadLogResponse, ReadWorkerConfig } from './read-worker-protocol.ts'

if (parentPort === null) throw new Error('JSONL read worker requires a parent port')
const port = parentPort

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Decode one selected current generation through the provider's read-only handle. */
async function decode(
  persistence: SessionPersistence,
  config: ReadWorkerConfig,
  request: ReadLogRequest,
): Promise<ReadLogResponse> {
  try {
    const before = fileRevision(await stat(request.path, { bigint: true }))
    if (before !== request.revision) return { request: request.request, ok: false, code: 'source-changed' }
    const handle = await persistence.open(SessionId(request.id), 'read')
    let header
    let inheritedEventCount
    let events
    try {
      header = handle.header
      inheritedEventCount = handle.inheritedEventCount
      events = [...(await handle.read()).events]
    } finally {
      await handle.close()
    }
    const after = fileRevision(await stat(request.path, { bigint: true }))
    // The caller selected this exact generation before asking; a changed
    // revision or a different selected generation must not be returned as if it
    // were that snapshot.
    const selected = generationLogPath(config.root, header.cwd, header.id, SESSION_FORMAT_VERSION, config.compression)
    if (before !== after || selected !== request.path) {
      return { request: request.request, ok: false, code: 'source-changed' }
    }
    return { request: request.request, ok: true, header, inheritedEventCount, events, revision: after }
  } catch (error: unknown) {
    if (errnoOf(error) === 'ENOENT') return { request: request.request, ok: false, code: 'source-changed' }
    const failure = error instanceof Error ? error : new Error(String(error))
    return {
      request: request.request,
      ok: false,
      code: 'decode-error',
      name: failure.name,
      message: failure.message,
      ...failure.stack === undefined ? {} : { stack: failure.stack },
      ...errnoOf(error) === undefined ? {} : { errorCode: errnoOf(error) as string },
    }
  }
}

/** Answer one message; malformed requests fail the worker so the owner rebuilds it. */
async function answer(
  persistence: SessionPersistence,
  config: ReadWorkerConfig,
  value: unknown,
): Promise<void> {
  let request: ReadLogRequest
  try {
    request = parseReadLogRequest(value)
  } catch (error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error))
    port.postMessage({ kind: 'failed', message: `malformed read worker request: ${failure.message}` })
    return
  }
  port.postMessage({ kind: 'response', response: await decode(persistence, config, request) })
}

async function serve(): Promise<void> {
  const config = parseReadWorkerConfig(workerData)
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, {
    root: config.root,
    compression: config.compression,
    readWorker: false,
  })
  const persistence = ctx.sessionPersistence
  let chain: Promise<void> = Promise.resolve()
  // Register the handler before announcing readiness so an immediate request
  // from the owner cannot be dropped at the MessagePort boundary.
  port.on('message', (value: unknown) => {
    chain = chain.then(() => answer(persistence, config, value))
  })
  port.postMessage({ kind: 'ready' })
}

void serve().catch((error: unknown) => {
  const failure = error instanceof Error ? error : new Error(String(error))
  port.postMessage({ kind: 'failed', message: failure.message })
  throw failure
})
