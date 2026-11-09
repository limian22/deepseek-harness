/**
 * On-demand MCP exposure: registration, bounded discovery, and
 * original-identity invocation through the shared guarded pipeline.
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Client } from '@modelcontextprotocol/client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { DISCOVERY_DEFAULTS, discoveryToolNames, resolveExposurePolicy } from '../src/discovery.ts'
import type { DiscoveryConfig } from '../src/discovery.ts'
import { syncTools } from '../src/tools.ts'
import type { ToolBridgeOptions } from '../src/tools.ts'

const testToolSignal = new AbortController().signal
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One catalog entry the mock server lists. */
interface MockTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** In-memory SDK client surface used by the bridge. */
interface MockClient {
  listTools: () => Promise<{ tools: MockTool[]; nextCursor: string | undefined }>
  callTool: (
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<Record<string, unknown>>
  getServerCapabilities: () => object
}

/**
 * Present a mock through the SDK client type. The bridge reads only `listTools`,
 * `callTool`, and `getServerCapabilities`, which the mock implements.
 * @param mock - in-memory client double.
 * @returns the same object typed as the SDK client.
 */
function asClient(mock: MockClient): Client {
  return mock as never
}

function createMockClient(
  catalog: MockTool[],
  callResult: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }] },
): Client {
  return asClient({
    listTools: async () => ({
      tools: catalog.map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      })),
      nextCursor: undefined,
    }),
    callTool: async () => ({ ...callResult }),
    getServerCapabilities: () => ({ tools: {} }),
  })
}

interface MockMountOptions {
  callResult?: Record<string, unknown>
  discovery?: DiscoveryConfig
  toolCallTimeoutMs?: number
}

async function mountDiscovery(catalog: MockTool[], options: MockMountOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const session = Session.create(SessionId('discovery'))
  const agent = { session, options: { provider: 'visual', model: 'vision' } } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const client = createMockClient(catalog, options.callResult)
  const policy = resolveExposurePolicy({ exposure: 'discovery', ...options.discovery === undefined ? {} : { discovery: options.discovery } }, 'test').discovery
  const opts: ToolBridgeOptions = {
    serverName: 'srv',
    toolCallTimeoutMs: options.toolCallTimeoutMs ?? 60_000,
    signal: testToolSignal,
    discovery: { policy, pipeline: new ToolExecutionPipeline(ctx) },
  }
  const disposers = await syncTools(client, ctx, opts, new Map())
  const call = (name: string, args: unknown, overrides: { signal?: AbortSignal; toolSet?: Parameters<typeof executeToolFixture>[1]['toolSet'] } = {}) =>
    executeToolFixture(ctx, {
      callId: ToolCallId(`${name}-call`),
      name,
      arguments: args,
      agent,
      signal: overrides.signal ?? testToolSignal,
      ...overrides.toolSet === undefined ? {} : { toolSet: overrides.toolSet },
    })
  return { ctx, agent, scope, client, disposers, call, session }
}

/** Require a successful helper value. */
function valueOf(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(`expected success, got: ${result.error?.message ?? 'unknown failure'}`)
  return result.value
}

interface DiscoverValue {
  query: string
  total: number
  offset: number
  results: { name: string; description: string; descriptionBytes: number; truncated: boolean }[]
  omitted: number
}

interface DescribeValue {
  name: string
  description: string
  parameters: JsonValue
  parametersBytes: number
}

describe('exposure configuration', () => {
  it('defaults to direct exposure with validated discovery budgets', () => {
    expect(resolveExposurePolicy({}, 'test')).toEqual({
      exposure: 'direct',
      discovery: DISCOVERY_DEFAULTS,
    })
  })

  it('rejects an unknown exposure and invalid or unknown discovery budgets', () => {
    expect(() => resolveExposurePolicy({ exposure: 'lazy' }, 'test')).toThrow('exposure must be "direct" or "discovery"')
    expect(() => resolveExposurePolicy({ discovery: { maxResults: 0 } }, 'test')).toThrow('maxResults must be a positive integer')
    expect(() => resolveExposurePolicy({ discovery: { maxResultBytes: 1.5 } }, 'test')).toThrow('maxResultBytes must be a positive integer')
    expect(() => resolveExposurePolicy({ discovery: { unknown: 3 } as DiscoveryConfig }, 'test')).toThrow('unknown is not a discovery option')
  })
})

describe('discovery registration', () => {
  it('keeps direct exposure unchanged by default', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await syncTools(createMockClient([{ name: 'echo' }]), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
    }, new Map())
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['mcp__srv__echo'])
    expect(ctx.tools.get('mcp__srv__echo')?.name).toBe('mcp__srv__echo')
  })

  it('advertises only the three helpers while every original stays registered', async () => {
    const catalog: MockTool[] = [
      { name: 'echo', description: 'Echo text back.' },
      { name: 'call_tool', description: 'A remote tool that happens to use a helper-like name.' },
      { name: 'admin.reset', description: 'Dotted name needing normalization.' },
    ]
    const h = await mountDiscovery(catalog)
    expect(h.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(
      Object.values(discoveryToolNames('srv')).sort(),
    )
    expect(h.ctx.tools.get('mcp__srv__echo')?.name).toBe('mcp__srv__echo')
    expect(h.ctx.tools.get('mcp__srv__call_tool')?.name).toBe('mcp__srv__call_tool')
  })

  it('removes helpers and originals together at disposal', async () => {
    const h = await mountDiscovery([{ name: 'echo' }])
    for (const dispose of h.disposers.values()) dispose()
    expect(h.ctx.tools.schemas()).toEqual([])
    expect(h.ctx.tools.get('mcp__srv__echo')).toBeUndefined()
    expect(h.ctx.tools.get(discoveryToolNames('srv').discover)).toBeUndefined()
  })
})

describe('discover helper', () => {
  it('returns bounded entries with paging and deterministic ordering', async () => {
    const h = await mountDiscovery([
      { name: 'zeta', description: 'Last alphabetically.' },
      { name: 'alpha', description: 'First alphabetically.' },
      { name: 'middle', description: 'Mentions needle.' },
    ])
    const page = valueOf(await h.call(discoveryToolNames('srv').discover, { limit: 2 })) as DiscoverValue
    expect(page.total).toBe(3)
    expect(page.results.map(entry => entry.name)).toEqual(['mcp__srv__alpha', 'mcp__srv__middle'])
    expect(page.omitted).toBe(1)
    const next = valueOf(await h.call(discoveryToolNames('srv').discover, { offset: 2, limit: 2 })) as DiscoverValue
    expect(next.results.map(entry => entry.name)).toEqual(['mcp__srv__zeta'])
    expect(next.omitted).toBe(0)
  })

  it('matches a case-insensitive substring of a name or description', async () => {
    const h = await mountDiscovery([
      { name: 'echo', description: 'Echo text back.' },
      { name: 'add', description: 'Add two numbers.' },
    ])
    const byName = valueOf(await h.call(discoveryToolNames('srv').discover, { query: 'ECHO' })) as DiscoverValue
    expect(byName.results.map(entry => entry.name)).toEqual(['mcp__srv__echo'])
    const byDescription = valueOf(await h.call(discoveryToolNames('srv').discover, { query: 'numbers' })) as DiscoverValue
    expect(byDescription.results.map(entry => entry.name)).toEqual(['mcp__srv__add'])
    const none = valueOf(await h.call(discoveryToolNames('srv').discover, { query: 'missing' })) as DiscoverValue
    expect(none.results).toEqual([])
    expect(none.total).toBe(0)
  })

  it('truncates an oversized description with an explicit omission marker and byte count', async () => {
    const longDescription = 'é'.repeat(400)
    const h = await mountDiscovery([{ name: 'long', description: longDescription }], {
      discovery: { maxResultBytes: 120 },
    })
    const value = valueOf(await h.call(discoveryToolNames('srv').discover, {})) as DiscoverValue
    const entry = value.results[0]
    if (entry === undefined) throw new Error('expected one entry')
    expect(entry.truncated).toBe(true)
    expect(entry.description).toContain('UTF-8 bytes omitted]')
    expect(entry.descriptionBytes).toBe(Buffer.byteLength(longDescription, 'utf8'))
    expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(120)
    const full = valueOf(await (await mountDiscovery([{ name: 'long', description: longDescription }])).call(
      discoveryToolNames('srv').discover, {},
    )) as DiscoverValue
    expect(full.results[0]?.description).toBe(longDescription)
  })

  it('drops tail entries into the explicit omitted count when the response budget is small', async () => {
    const catalog: MockTool[] = Array.from({ length: 5 }, (_, index) => ({
      name: `tool_${String(index)}`,
      description: 'A description',
    }))
    const h = await mountDiscovery(catalog, { discovery: { maxResponseBytes: 260 } })
    const value = valueOf(await h.call(discoveryToolNames('srv').discover, {})) as DiscoverValue
    expect(value.total).toBe(5)
    expect(value.results.length).toBeLessThan(5)
    expect(value.omitted).toBe(5 - value.results.length)
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeLessThanOrEqual(260)
  })

  it('fails loud instead of claiming no match when nothing fits the response budget', async () => {
    const h = await mountDiscovery([{ name: 'echo', description: 'Echo' }], { discovery: { maxResponseBytes: 30 } })
    const result = await h.call(discoveryToolNames('srv').discover, {})
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('maxResponseBytes')
  })

  it('clamps the requested limit to the configured maximum', async () => {
    const h = await mountDiscovery([{ name: 'a' }, { name: 'b' }, { name: 'c' }], {
      discovery: { maxResults: 2 },
    })
    const value = valueOf(await h.call(discoveryToolNames('srv').discover, { limit: 10 })) as DiscoverValue
    expect(value.results).toHaveLength(2)
    expect(value.omitted).toBe(1)
  })
})

describe('describe helper', () => {
  it('returns one exact tool with its full schema', async () => {
    const h = await mountDiscovery([{
      name: 'echo',
      description: 'Echo text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
    }])
    const value = valueOf(await h.call(discoveryToolNames('srv').describe, { name: 'mcp__srv__echo' })) as DescribeValue
    expect(value.name).toBe('mcp__srv__echo')
    expect(value.description).toBe('Echo text back.')
    expect(value.parameters).toEqual({ type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] })
    expect(value.parametersBytes).toBe(Buffer.byteLength(JSON.stringify(value.parameters), 'utf8'))
  })

  it('reports an unknown name explicitly', async () => {
    const h = await mountDiscovery([{ name: 'echo' }])
    const result = await h.call(discoveryToolNames('srv').describe, { name: 'mcp__srv__missing' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('does not publish it')
  })

  it('bounds the rendered describe response, not only its canonical value', async () => {
    const schema = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        `field_${String(index)}`,
        { type: 'string', description: 'Synthetic field description.' },
      ])),
    }
    const probe = await mountDiscovery([{ name: 'wide', description: 'Wide schema', inputSchema: schema }])
    const ok = await probe.call(discoveryToolNames('srv').describe, { name: 'mcp__srv__wide' })
    expect(ok.isError).toBe(false)
    const canonical = Buffer.byteLength(JSON.stringify(valueOf(ok)), 'utf8')
    const rendered = Buffer.byteLength(JSON.stringify(ok.content), 'utf8')
    // Pretty-printed parameters keep the model-facing rendering well above the canonical value.
    expect(rendered).toBeGreaterThan(canonical + 100)

    const between = await mountDiscovery([{ name: 'wide', description: 'Wide schema', inputSchema: schema }], {
      discovery: { maxResponseBytes: canonical + 1 },
    })
    const bounded = await between.call(discoveryToolNames('srv').describe, { name: 'mcp__srv__wide' })
    expect(bounded.isError).toBe(true)
    expect(bounded.error?.message).toContain('maxResponseBytes')

    const exact = await mountDiscovery([{ name: 'wide', description: 'Wide schema', inputSchema: schema }], {
      discovery: { maxResponseBytes: rendered },
    })
    expect((await exact.call(discoveryToolNames('srv').describe, { name: 'mcp__srv__wide' })).isError).toBe(false)
  })

  it('refuses a schema over the configured byte budget with a config hint', async () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`p${String(index)}`, { type: 'string', description: 'x'.repeat(40) }])),
    }
    const h = await mountDiscovery([{ name: 'big', inputSchema: bigSchema }], {
      discovery: { maxSchemaBytes: 200 },
    })
    const result = await h.call(discoveryToolNames('srv').describe, { name: 'mcp__srv__big' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('discovery.maxSchemaBytes')
  })
})

describe('call helper', () => {
  const helper = discoveryToolNames('srv').call

  it('dispatches an original by its original public name with unchanged arguments', async () => {
    const callTool = vi.fn(async (_params?: Record<string, unknown>, _options?: unknown): Promise<Record<string, unknown>> => ({ content: [{ type: 'text', text: 'Hello, Ada!' }] }))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-call'))
    const agent = { session, options: {} } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'greet', description: 'Greet', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }],
        nextCursor: undefined,
      }),
      callTool,
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-greet'), name: helper, arguments: { name: 'mcp__srv__greet', arguments: { name: 'Ada' } }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(false)
    expect(callTool).toHaveBeenCalledOnce()
    expect(callTool.mock.calls[0]?.[0]).toEqual({ name: 'greet', arguments: { name: 'Ada' } })
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada!' }])
    const events = session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
    expect(events[0]?.type === 'tool/ptc-dispatch-start' && events[0].data.name).toBe('mcp__srv__greet')
    expect(events[1]?.type === 'tool/ptc-dispatch' && events[1].data.name).toBe('mcp__srv__greet')
    expect(events[1]?.type === 'tool/ptc-dispatch' && events[1].data.isError).toBe(false)
  })

  it('applies original-name policy denial with zero remote side effects', async () => {
    const callTool = vi.fn()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-deny'))
    const agent = { session, options: {} } as Agent
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'mcp__srv__echo') return { kind: 'deny', reason: 'blocked by policy' }
      return next()
    })
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool,
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-denied'), name: helper, arguments: { name: 'mcp__srv__echo', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: blocked by policy' }])
    expect(callTool).not.toHaveBeenCalled()
    const events = session.snapshotEvents()
    const settled = events[1]
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.name).toBe('mcp__srv__echo')
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.isError).toBe(true)
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.content).toEqual([{ type: 'text', text: 'Error: blocked by policy' }])
  })

  it('never forwards a raw error message a post-execute policy replaced', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-redact'))
    const agent = { session, options: {} } as Agent
    ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const decision = await next()
      if (exec.name !== 'mcp__srv__fail' || !result.isError) return decision
      return { kind: 'block', feedback: [{ type: 'text', text: 'upstream failure (details withheld)' }] }
    })
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'fail', description: 'Fail', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool: async () => ({ content: [{ type: 'text', text: 'secret token abc123' }], isError: true }),
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-redact'), name: helper, arguments: { name: 'mcp__srv__fail', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'upstream failure (details withheld)' }])
    expect(JSON.stringify(result)).not.toContain('abc123')
    const settled = session.snapshotEvents()[1]
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.content).toEqual([{ type: 'text', text: 'upstream failure (details withheld)' }])
  })

  it('lets an outer post-execute block replace the captured failure content', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-outer-block'))
    const agent = { session, options: {} } as Agent
    ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const decision = await next()
      if (exec.name === 'mcp__srv__fail' && result.isError) {
        return { kind: 'block', feedback: [{ type: 'text', text: 'nested failure (authoritative)' }] }
      }
      if (exec.name === helper && result.isError) {
        return { kind: 'block', feedback: [{ type: 'text', text: 'outer policy replaced the failure' }] }
      }
      return decision
    })
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'fail', description: 'Fail', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool: async () => ({ content: [{ type: 'text', text: 'raw upstream detail' }], isError: true }),
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-outer-block'), name: helper, arguments: { name: 'mcp__srv__fail', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'outer policy replaced the failure' }])
    expect(JSON.stringify(result)).not.toContain('raw upstream detail')
    const settled = session.snapshotEvents()[1]
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.content).toEqual([{ type: 'text', text: 'nested failure (authoritative)' }])
  })

  it('rejects an original restricted away from the caller without a remote call', async () => {
    const h = await mountDiscovery([{ name: 'echo', description: 'Echo' }])
    const lift = h.scope.ctx.tools.restrict({ deny: ['mcp__srv__echo'] })
    const result = await h.call(helper, { name: 'mcp__srv__echo', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
    lift()
    const allowed = await h.call(helper, { name: 'mcp__srv__echo', arguments: {} })
    expect(allowed.isError).toBe(false)
  })

  it('does not route a same-name foreign shadow', async () => {
    const h = await mountDiscovery([{ name: 'echo', description: 'Echo' }])
    h.scope.ctx.tools.register({
      name: 'mcp__srv__echo',
      description: 'Foreign shadow.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'shadow' }] },
      async execute() { return 'shadow' },
    })
    const result = await h.call(helper, { name: 'mcp__srv__echo', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('aborts the nested dispatch and records the settlement when cancelled', async () => {
    let observed: AbortSignal | undefined
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-abort'))
    const agent = { session, options: {} } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'slow', description: 'Slow', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool: async (_params, options) => {
        observed = options?.signal
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
        return { content: [] }
      },
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const controller = new AbortController()
    const pending = executeToolFixture(ctx, {
      callId: ToolCallId('call-slow'), name: helper, arguments: { name: 'mcp__srv__slow', arguments: {} }, agent, signal: controller.signal,
    })
    await vi.waitFor(() => { expect(observed).toBeDefined() })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(observed?.aborted).toBe(true)
    const events = session.snapshotEvents()
    expect(events[1]?.type === 'tool/ptc-dispatch' && events[1].data.isError).toBe(true)
  })

  it('does not invoke a tool from a replaced generation', async () => {
    const h = await mountDiscovery([{ name: 'echo', description: 'Echo' }])
    await syncTools(createMockClient([{ name: 'add', description: 'Add' }]), h.ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(h.ctx) },
    }, h.disposers)
    const stale = await h.call(helper, { name: 'mcp__srv__echo', arguments: {} })
    expect(stale.isError).toBe(true)
    expect(stale.error?.info?.code).toBe('UNKNOWN_TOOL')
    const current = await h.call(helper, { name: 'mcp__srv__add', arguments: {} })
    expect(current.isError).toBe(false)
  })

  it('forwards deferred context and images from the original result', async () => {
    class RecordingAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 2048,
        maxImagePixels: 1024, maxImageDimension: 2000,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      }
      readonly saved: SaveImageAttachment[] = []
      validateImage(_input: SaveImageAttachment): Promise<void> { return Promise.resolve() }
      saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        this.saved.push(input)
        return Promise.resolve({
          attachmentId: AttachmentId(`sha256:${'0'.repeat(64)}`),
          mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
        })
      }
      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> { throw new Error('not used') }
    }
    class ImageCatalogAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
      }

      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('MCP discovery tests never stream')
      }
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(RecordingAttachmentStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['visual'], new ImageCatalogAdapter())
    const session = Session.create(SessionId('discovery-image'))
    session.append('turn/start', { turn: 1 })
    const agent = { session, options: { provider: 'visual', model: 'vision' } } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'image', description: 'Image', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool: async () => ({
        content: [
          { type: 'text', text: 'Here is an image:' },
          { type: 'image', mimeType: 'image/png', data: 'AQ==' },
        ],
      }),
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-image'), name: helper, arguments: { name: 'mcp__srv__image', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(false)
    const store = ctx.attachments as RecordingAttachmentStore
    expect(store.saved).toHaveLength(1)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Here is an image:\n[image result; forwarded as separate context when available]',
    }])
    const deferred = result.additionalContexts ?? []
    expect(deferred).toHaveLength(1)
    expect(deferred[0]?.source).toEqual({ kind: 'mcp-mode' })
    expect(deferred[0]?.content.some(block => block.type === 'image')).toBe(true)
  })

  it('passes invalid original arguments through to the original tool', async () => {
    const callTool = vi.fn(async (_params?: Record<string, unknown>, _options?: unknown): Promise<Record<string, unknown>> => ({
      content: [{ type: 'text', text: 'missing required field: text' }],
      isError: true,
    }))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-invalid-args'))
    const agent = { session, options: {} } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{
          name: 'echo',
          description: 'Echo',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
        nextCursor: undefined,
      }),
      callTool,
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-invalid-args'), name: helper, arguments: { name: 'mcp__srv__echo', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(callTool).toHaveBeenCalledOnce()
    expect(callTool.mock.calls[0]?.[0]).toEqual({ name: 'echo', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: missing required field: text' }])
    const settled = session.snapshotEvents()[1]
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.name).toBe('mcp__srv__echo')
    expect(settled?.type === 'tool/ptc-dispatch' && settled.data.isError).toBe(true)
  })

  it('asks approval under the original tool name and dispatches on allow', async () => {
    const requests: { toolName: string; reason: string | undefined }[] = []
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('approval', {
      request: async (request: { toolName: string; reason?: string }) => {
        requests.push({ toolName: request.toolName, reason: request.reason })
        return 'allowed-once'
      },
    })
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'approved result' }] }))
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'mcp__srv__echo') return { kind: 'ask', reason: 'needs a human' }
      return next()
    })
    const session = Session.create(SessionId('discovery-approval-allow'))
    const agent = { session, options: {} } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool,
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-approval-allow'), name: helper, arguments: { name: 'mcp__srv__echo', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(false)
    expect(requests).toEqual([{ toolName: 'mcp__srv__echo', reason: 'needs a human' }])
    expect(callTool).toHaveBeenCalledOnce()
  })

  it('reports an approval rejection under the original tool name without a remote call', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('approval', { request: async () => 'rejected' })
    const callTool = vi.fn()
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'mcp__srv__echo') return { kind: 'ask', reason: 'needs a human' }
      return next()
    })
    const session = Session.create(SessionId('discovery-approval-reject'))
    const agent = { session, options: {} } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool,
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-approval-reject'), name: helper, arguments: { name: 'mcp__srv__echo', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: the user rejected tool "mcp__srv__echo"' }])
    expect(callTool).not.toHaveBeenCalled()
  })

  it('forwards the configured per-call timeout to the MCP client', async () => {
    const callTool = vi.fn(async (
      _params?: Record<string, unknown>,
      _options?: { timeout?: number },
    ): Promise<Record<string, unknown>> => ({
      content: [{ type: 'text', text: 'ok' }],
    }))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const session = Session.create(SessionId('discovery-timeout'))
    const agent = { session, options: {} } as Agent
    await syncTools(asClient({
      listTools: async () => ({
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: undefined,
      }),
      callTool,
      getServerCapabilities: () => ({ tools: {} }),
    }), ctx, {
      serverName: 'srv', toolCallTimeoutMs: 1_234, signal: testToolSignal,
      discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
    }, new Map())
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('call-timeout'), name: helper, arguments: { name: 'mcp__srv__echo', arguments: {} }, agent, signal: testToolSignal,
    })
    expect(result.isError).toBe(false)
    expect(callTool.mock.calls[0]?.[1]?.timeout).toBe(1_234)
  })
})

describe('synthetic declaration metrics', () => {
  /** Fixed synthetic catalog: constant long descriptions and nested parameter schemas. */
  function syntheticCatalog(count: number): MockTool[] {
    return Array.from({ length: count }, (_, index) => ({
      name: `synthetic_tool_${String(index).padStart(3, '0')}`,
      description: `Synthetic remote tool ${String(index)} with a fixed, substantial description used only for declaration-byte measurement across catalog sizes.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text argument for the synthetic tool.' },
          count: { type: 'integer', description: 'Optional repetition count.' },
          nested: {
            type: 'object',
            properties: {
              alpha: { type: 'string' },
              beta: { type: 'number' },
            },
            required: ['alpha'],
          },
        },
        required: ['text'],
      },
    }))
  }

  async function declarations(mode: 'direct' | 'discovery', tools: MockTool[]) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    if (mode === 'discovery') {
      await syncTools(createMockClient(tools), ctx, {
        serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
        discovery: { policy: DISCOVERY_DEFAULTS, pipeline: new ToolExecutionPipeline(ctx) },
      }, new Map())
    } else {
      await syncTools(createMockClient(tools), ctx, {
        serverName: 'srv', toolCallTimeoutMs: 60_000, signal: testToolSignal,
      }, new Map())
    }
    const schemas = ctx.tools.schemas()
    return {
      bytes: Buffer.byteLength(JSON.stringify(schemas), 'utf8'),
      names: schemas.map(schema => schema.name),
      keys: schemas.map(schema => Object.keys(schema)),
    }
  }

  it('pins the direct-versus-discovery declaration cost on fixed catalogs', async () => {
    const directSmall = await declarations('direct', syntheticCatalog(5))
    const directLarge = await declarations('direct', syntheticCatalog(250))
    const discoverySmall = await declarations('discovery', syntheticCatalog(5))
    const discoveryLarge = await declarations('discovery', syntheticCatalog(250))

    // Fixed baseline shape: exactly the three helpers, in registration order,
    // with only the model-facing schema fields.
    expect(discoveryLarge.names).toEqual(['mcp_discover__srv', 'mcp_describe__srv', 'mcp_call__srv'])
    for (const keys of discoveryLarge.keys) expect(keys).toEqual(['name', 'description', 'parameters'])
    expect(discoverySmall.names).toEqual(discoveryLarge.names)
    expect(discoverySmall.bytes).toBe(discoveryLarge.bytes)
    expect(directSmall.names).toHaveLength(5)
    expect(directLarge.names).toHaveLength(250)

    // Exact metrics: serialized UTF-8 declaration bytes for the fixed catalogs.
    expect(discoveryLarge.bytes).toBe(1_356)
    expect(directSmall.bytes).toBe(2_561)
    expect(directLarge.bytes).toBe(128_391)
    // Discovery stays smaller even than a five-tool direct catalog, and its
    // declarations do not move as the remote catalog grows.
    expect(discoveryLarge.bytes).toBeLessThan(directSmall.bytes)
    expect(discoverySmall.bytes).toBe(discoveryLarge.bytes)
    // Declaration-count and byte ratios for the 250-tool catalog.
    expect(directLarge.names.length / discoveryLarge.names.length).toBeCloseTo(83.333333, 5)
    expect(directLarge.bytes / discoveryLarge.bytes).toBeCloseTo(94.68362831858407, 6)
  })
})
