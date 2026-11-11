import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { mapStopReason, toStreamChunks } from '../src/stream.ts'

type Diagnostic = NonNullable<AssistantMessage['diagnostics']>[number]

function failed(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6.1-sol',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error', errorMessage: 'WebSocket error', timestamp: 1000,
    ...overrides,
  }
}

function transport(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    type: 'provider_transport_failure', timestamp: 153000,
    error: { name: 'Error', message: 'WebSocket error', code: 'ECONNRESET' },
    details: { configuredTransport: 'auto', phase: 'after_message_stream_start', eventsEmitted: true },
    ...overrides,
  }
}

function failure(message: AssistantMessage) {
  const reason = mapStopReason(message)
  if (reason.kind !== 'error') throw new Error('Expected a provider failure')
  return reason.failure
}

function diagnostics(message: string) {
  const marker = '\npi-ai diagnostics: '
  expect(message).toContain(marker)
  return JSON.parse(message.slice(message.lastIndexOf(marker) + marker.length))
}

async function* errorEvent(error: AssistantMessage): AsyncGenerator<AssistantMessageEvent> {
  yield { type: 'error', reason: 'error', error }
}

const identity = { provider: 'openai-codex', model: 'gpt-6.1-sol', api: 'openai-codex-responses' }

describe('PI error diagnostics', () => {
  it('preserves the opaque error and reports the last transport failure without changing retry eligibility', () => {
    const result = failure(failed({ diagnostics: [transport()] }))
    expect(result.code).toBe('PI_AI_ERROR')
    const policy = resolveRetryPolicy(undefined, 'diagnostics test')
    expect(policy.mode).toBe('normal')
    if (policy.mode === 'normal') expect(policy.retryableCodes).not.toContain(result.code)
    expect(result.message).toBe('WebSocket error\npi-ai diagnostics: ' + JSON.stringify({
      ...identity,
      lastTransportFailure: {
        configuredTransport: 'auto', phase: 'after_message_stream_start', errorCode: 'ECONNRESET',
        eventsEmitted: true, elapsedMs: 152000,
      },
    }))
  })

  it('reports unavailable transport information rather than inventing a cause', () => {
    const result = failure(failed())
    expect(result.message).toMatch(/^WebSocket error\n/)
    expect(diagnostics(result.message)).toEqual({ ...identity, lastTransportFailure: 'not provided' })
  })

  it('uses the latest transport diagnostic and identifies a recorded fallback rather than the final cause', () => {
    const result = failure(failed({ diagnostics: [
      transport({ details: { phase: 'after_message_stream_start' } }),
      transport({ timestamp: 2000, details: {
        configuredTransport: 'websocket', fallbackTransport: 'sse', phase: 'before_message_stream_start', eventsEmitted: false,
      } }),
      { type: 'other-diagnostic', timestamp: 3000, error: { message: 'secret body' }, details: { phase: 'wrong phase' } },
    ] }))
    expect(diagnostics(result.message)).toEqual({ ...identity, lastTransportFailure: {
      configuredTransport: 'websocket', phase: 'before_message_stream_start', errorCode: 'ECONNRESET',
      fallbackTransport: 'sse', eventsEmitted: false, elapsedMs: 1000,
    } })
  })

  it('does not expose extra diagnostic messages, stacks, payloads, headers, URLs, or arbitrary codes', () => {
    const secret = 'sensitive-provider-detail'
    const result = failure(failed({ diagnostics: [transport({
      error: { name: secret, message: secret, stack: secret, code: secret },
      details: {
        configuredTransport: secret, fallbackTransport: secret, phase: secret,
        headers: { authorization: secret }, body: secret, payload: secret, url: `https://example.invalid/?token=${secret}`,
        eventsEmitted: false,
      },
    })] }))
    expect(result.message).not.toContain(secret)
    expect(diagnostics(result.message)).toEqual({ ...identity, lastTransportFailure: {
      configuredTransport: 'not available', phase: 'not available', errorCode: 'not available', eventsEmitted: false, elapsedMs: 152000,
    } })
  })

  it.each(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 1012, 401])('retains safe upstream error code %s as diagnostic data only', (code) => {
    const result = failure(failed({ diagnostics: [transport({ error: { message: 'WebSocket error', code } })] }))
    expect(result.code).toBe('PI_AI_ERROR')
    expect(diagnostics(result.message).lastTransportFailure.errorCode).toBe(code)
  })

  it('omits elapsed time if the system clock moved backwards', () => {
    const result = failure(failed({ diagnostics: [transport({ timestamp: 999 })] }))
    expect(diagnostics(result.message).lastTransportFailure).not.toHaveProperty('elapsedMs')
  })

  it('reports missing error and detail fields without exposing extra data', () => {
    const diagnostic: Diagnostic = { type: 'provider_transport_failure', timestamp: 153000 }
    const result = failure(failed({ diagnostics: [diagnostic] }))
    expect(diagnostics(result.message)).toEqual({ ...identity, lastTransportFailure: {
      configuredTransport: 'not available', phase: 'not available', errorCode: 'not available', elapsedMs: 152000,
    } })
  })

  it('does not report arbitrary event-emission data as a boolean', () => {
    const result = failure(failed({ diagnostics: [transport({ details: { eventsEmitted: 'sensitive-detail' } })] }))
    expect(result.message).not.toContain('sensitive-detail')
    expect(diagnostics(result.message).lastTransportFailure).not.toHaveProperty('eventsEmitted')
  })

  it.each([-1, 1.5, 65536])('does not report non-protocol numeric code %s', (code) => {
    const result = failure(failed({ diagnostics: [transport({ error: { message: 'WebSocket error', code } })] }))
    expect(diagnostics(result.message).lastTransportFailure.errorCode).toBe('not available')
  })

  it.each([
    ['HTTP 401: rejected', 'AUTH'], ['HTTP 429: rate limit', 'RATE_LIMIT'],
    ['insufficient_quota', 'QUOTA'], ['invalid request', 'INVALID_REQUEST'],
    ['HTTP 500: unavailable', 'SERVER'], ['timed out', 'TIMEOUT'],
    ['WebSocket closed 1012', 'TRANSPORT'], ['context length exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
  ])('preserves the classified failure %s', (errorMessage, code) => {
    expect(mapStopReason(failed({ errorMessage, diagnostics: [transport()] }))).toEqual({
      kind: 'error', failure: { message: errorMessage, code },
    })
  })

  it('carries diagnostic text through the actual terminal stream conversion', async () => {
    const chunks = []
    for await (const chunk of toStreamChunks(errorEvent(failed({ diagnostics: [transport()] })))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: {
      kind: 'error', failure: { code: 'PI_AI_ERROR', message: expect.stringContaining('"phase":"after_message_stream_start"') },
    } })
  })

  it('keeps caller cancellation aborted without attaching failure diagnostics', async () => {
    const caller = new AbortController()
    caller.abort()
    const chunks = []
    const stream = toStreamChunks(errorEvent(failed({ diagnostics: [transport()] })), undefined, caller.signal)
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({
      type: 'finish', reason: { kind: 'aborted', failure: { message: 'WebSocket error', code: 'ABORTED' } },
    })
  })

  it('does not convert a successful response with an earlier transport diagnostic into a failure', () => {
    expect(mapStopReason(failed({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }], diagnostics: [transport()] })))
      .toEqual({ kind: 'stop' })
  })
})
