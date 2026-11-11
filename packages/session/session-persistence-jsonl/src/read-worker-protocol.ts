/**
 * Process-boundary validation for the JSONL read worker. The worker decodes a
 * current generation with a second provider instance; every request, response,
 * and lifecycle message crosses a Worker Thread boundary and is validated here
 * before either side trusts its fields.
 * @module
 */

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Physical encodings the read worker can decode. */
export type ReadWorkerCompression = 'none' | 'zstd'

/** Fixed worker configuration, carried once at spawn. */
export interface ReadWorkerConfig {
  readonly root: string
  readonly compression: ReadWorkerCompression
}

/** One cold-read request for an already-selected current artifact. */
export interface ReadLogRequest {
  /** Monotonic per-client token echoed by the response. */
  readonly request: number
  readonly id: string
  /** The current generation path the caller selected and revision-checked. */
  readonly path: string
  /** The stat-derived revision the caller selected; the worker refuses a different snapshot. */
  readonly revision: string
}

/** One decoded current log, detached from the worker's provider ownership. */
export type ReadLogResponse =
  | {
    readonly request: number
    readonly ok: true
    readonly header: SessionHeader
    readonly inheritedEventCount: number
    readonly events: readonly SessionEvent[]
    readonly revision: string
  }
  | { readonly request: number; readonly ok: false; readonly code: 'source-changed' }
  | {
    readonly request: number
    readonly ok: false
    readonly code: 'decode-error'
    readonly name: string
    readonly message: string
    readonly stack?: string
    readonly errorCode?: string
  }

/** One message from the worker: readiness, startup failure, or a response. */
export type ReadWorkerMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'response'; readonly response: ReadLogResponse }

const HEADER_FIELDS: readonly string[] = [
  'version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject fields that this boundary does not define, so a version skew fails loudly. */
function assertOnlyFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} carries unknown field "${key}"`)
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function assertStoredHeader(value: unknown): void {
  if (!isRecord(value)) throw new Error('read worker header must be an object')
  assertOnlyFields(value, HEADER_FIELDS, 'read worker header')
  const { id, version, createdAt, isSeeded } = value
  if (typeof id !== 'string' || id === '') throw new Error('read worker header id must be a non-empty string')
  if (version !== SESSION_FORMAT_VERSION) {
    throw new Error(`read worker header version must be ${String(SESSION_FORMAT_VERSION)}`)
  }
  if (!isSafeNonNegativeInteger(createdAt)) {
    throw new Error('read worker header createdAt must be a non-negative safe integer')
  }
  if (typeof isSeeded !== 'boolean') throw new Error('read worker header isSeeded must be a boolean')
  const { cwd, parentSession, origin, delegationDepth, agentPreset } = value
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('read worker header cwd must be a string')
  if (parentSession !== undefined && (typeof parentSession !== 'string' || parentSession === '')) {
    throw new Error('read worker header parentSession must be a non-empty string')
  }
  if (origin !== undefined && origin !== 'subagent') throw new Error('read worker header origin is unsupported')
  if (delegationDepth !== undefined && !isSafeNonNegativeInteger(delegationDepth)) {
    throw new Error('read worker header delegationDepth must be a non-negative safe integer')
  }
  if (agentPreset !== undefined && typeof agentPreset !== 'string') {
    throw new Error('read worker header agentPreset must be a string')
  }
}

/** Reject malformed event envelopes; the backend validates each record's payload after adoption. */
function assertStoredEvents(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('read worker events must be an array')
  for (const event of value) {
    if (!isRecord(event) || typeof event.type !== 'string' || event.type === '') {
      throw new Error('read worker event must be an object carrying a type')
    }
    if (!isSafeNonNegativeInteger(event.seq)) {
      throw new Error('read worker event seq must be a non-negative safe integer')
    }
  }
}

/**
 * Validate the worker's fixed spawn configuration.
 * @param value - untrusted worker data.
 * @returns the validated root and physical encoding.
 * @throws when the payload is not a supported configuration.
 */
export function parseReadWorkerConfig(value: unknown): ReadWorkerConfig {
  if (!isRecord(value)) throw new Error('read worker config must be an object')
  assertOnlyFields(value, ['root', 'compression'], 'read worker config')
  const { root, compression } = value
  if (typeof root !== 'string' || root === '') throw new Error('read worker config root must be a non-empty string')
  if (compression !== 'none' && compression !== 'zstd') {
    throw new Error('read worker config compression must be "none" or "zstd"')
  }
  return { root, compression }
}

/**
 * Validate one cold-read request.
 * @param value - untrusted message payload.
 * @returns the validated request.
 * @throws when the payload is not a supported request.
 */
export function parseReadLogRequest(value: unknown): ReadLogRequest {
  if (!isRecord(value)) throw new Error('read worker request must be an object')
  assertOnlyFields(value, ['request', 'id', 'path', 'revision'], 'read worker request')
  const { request, id, path, revision } = value
  if (!isSafeNonNegativeInteger(request) || request === 0) {
    throw new Error('read worker request token must be a positive safe integer')
  }
  if (typeof id !== 'string' || id === '') throw new Error('read worker request id must be a non-empty string')
  if (typeof path !== 'string' || path === '') throw new Error('read worker request path must be a non-empty string')
  if (typeof revision !== 'string' || revision === '') {
    throw new Error('read worker request revision must be a non-empty string')
  }
  return { request, id: id, path, revision }
}

/**
 * Validate one response.
 * @param value - untrusted response payload.
 * @returns the validated response.
 * @throws when the payload is not a supported response.
 */
export function parseReadLogResponse(value: unknown): ReadLogResponse {
  if (!isRecord(value)) throw new Error('read worker response must be an object')
  const { request, ok } = value
  if (!isSafeNonNegativeInteger(request) || request === 0) {
    throw new Error('read worker response token must be a positive safe integer')
  }
  if (typeof ok !== 'boolean') throw new Error('read worker response ok must be a boolean')
  if (ok) {
    assertOnlyFields(value, ['request', 'ok', 'header', 'inheritedEventCount', 'events', 'revision'], 'read worker response')
    assertStoredHeader(value.header)
    if (!isSafeNonNegativeInteger(value.inheritedEventCount)) {
      throw new Error('read worker response inheritedEventCount must be a non-negative safe integer')
    }
    assertStoredEvents(value.events)
    if (typeof value.revision !== 'string' || value.revision === '') {
      throw new Error('read worker response revision must be a non-empty string')
    }
    return value as ReadLogResponse
  }
  const { code } = value
  if (code === 'source-changed') {
    assertOnlyFields(value, ['request', 'ok', 'code'], 'read worker response')
    return value as ReadLogResponse
  }
  if (code === 'decode-error') {
    assertOnlyFields(value, ['request', 'ok', 'code', 'name', 'message', 'stack', 'errorCode'], 'read worker response')
    if (typeof value.name !== 'string' || value.name === '') {
      throw new Error('read worker decode error name must be a non-empty string')
    }
    if (typeof value.message !== 'string') throw new Error('read worker decode error message must be a string')
    if (value.stack !== undefined && typeof value.stack !== 'string') {
      throw new Error('read worker decode error stack must be a string')
    }
    if (value.errorCode !== undefined && typeof value.errorCode !== 'string') {
      throw new Error('read worker decode error code must be a string')
    }
    return value as ReadLogResponse
  }
  throw new Error('read worker response code is unsupported')
}

/**
 * Validate one lifecycle or response message from the worker.
 * @param value - untrusted message.
 * @returns the validated message.
 * @throws when the payload is not a supported message.
 */
export function parseReadWorkerMessage(value: unknown): ReadWorkerMessage {
  if (!isRecord(value)) throw new Error('read worker message must be an object')
  if (value.kind === 'ready') {
    assertOnlyFields(value, ['kind'], 'read worker message')
    return { kind: 'ready' }
  }
  if (value.kind === 'failed') {
    assertOnlyFields(value, ['kind', 'message'], 'read worker message')
    if (typeof value.message !== 'string' || value.message === '') {
      throw new Error('read worker failure message must be a non-empty string')
    }
    return { kind: 'failed', message: value.message }
  }
  if (value.kind === 'response') {
    assertOnlyFields(value, ['kind', 'response'], 'read worker message')
    return { kind: 'response', response: parseReadLogResponse(value.response) }
  }
  throw new Error('read worker message kind is unsupported')
}
