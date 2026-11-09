/** Shared durable records for one nested dispatch inside a composite tool. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { appendSubDispatch, appendSubDispatchStart } from '@deepseek-ai/dsh-tools'
import type { SubDispatchSettlement, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId('sub-dispatch'))
  const agent = { session } as Agent
  const parent = {
    callId: ToolCallId('outer-call'),
    rootCallId: ToolCallId('root-call'),
    name: 'outer',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('outer-token') as ToolExecutionToken,
  } as ToolExecution
  const settlement: SubDispatchSettlement = {
    exec: parent,
    subCallId: ToolCallId('outer-call:test:1'),
    name: 'inner-tool',
    isError: false,
    content: [{ type: 'text', text: 'inner output' }],
    arguments: {},
  }
  return { ctx, session, agent, parent, settlement }
}

it('records a nested dispatch start under the established durable event key', async () => {
  const h = await setup()
  appendSubDispatchStart(h.agent, {
    rootCallId: h.parent.rootCallId,
    parentCallId: h.parent.callId,
    subCallId: ToolCallId('outer-call:test:1'),
    name: 'inner-tool',
    arguments: { text: 'hi' },
  })
  const events = h.session.snapshotEvents()
  expect(events.map(event => event.type)).toEqual(['tool/ptc-dispatch-start'])
  expect(events[0]).toMatchObject({
    type: 'tool/ptc-dispatch-start',
    data: {
      rootCallId: 'root-call',
      parentCallId: 'outer-call',
      subCallId: 'outer-call:test:1',
      name: 'inner-tool',
      arguments: { text: 'hi' },
    },
  })
})

it('records a settled nested dispatch with content, meta, and structured error identity', async () => {
  const h = await setup()
  await appendSubDispatch(h.ctx, h.ctx.tools, h.agent, {
    ...h.settlement,
    isError: true,
    content: [{ type: 'text', text: 'Error: denied by policy' }],
    arguments: { text: 'hi' },
    meta: { card: 'denied' },
    error: { name: 'HarnessError', code: 'denied', reason: 'policy' },
  })
  const events = h.session.snapshotEvents()
  expect(events.map(event => event.type)).toEqual(['tool/ptc-dispatch'])
  expect(events[0]).toMatchObject({
    type: 'tool/ptc-dispatch',
    data: {
      rootCallId: 'root-call',
      parentCallId: 'outer-call',
      subCallId: 'outer-call:test:1',
      name: 'inner-tool',
      arguments: { text: 'hi' },
      isError: true,
      content: [{ type: 'text', text: 'Error: denied by policy' }],
      meta: { card: 'denied' },
      error: { name: 'HarnessError', code: 'denied', reason: 'policy' },
    },
  })
})

it('lets a durable-log listener replace the recorded content only', async () => {
  const h = await setup()
  h.ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    expect(dispatch.agent).toBe(h.agent)
    expect(dispatch.name).toBe('inner-tool')
    await next()
    return [{ type: 'text', text: 'spilled: preview only' }]
  })
  await appendSubDispatch(h.ctx, h.ctx.tools, h.agent, h.settlement)
  const event = h.session.snapshotEvents()[0]
  expect(event?.type).toBe('tool/ptc-dispatch')
  expect(event?.type === 'tool/ptc-dispatch' && event.data.content).toEqual([{ type: 'text', text: 'spilled: preview only' }])
})

it('contains a failing log listener and records the original settled content', async () => {
  const h = await setup()
  h.ctx.on('tools/ptc-dispatch-log', () => { throw new Error('spill backend unavailable') })
  await appendSubDispatch(h.ctx, h.ctx.tools, h.agent, h.settlement)
  const event = h.session.snapshotEvents()[0]
  expect(event?.type === 'tool/ptc-dispatch' && event.data.content).toEqual([{ type: 'text', text: 'inner output' }])
})

/** Context whose `tools` service is unreachable, as during fiber unload. */
function inactiveContext(ctx: Context): Context {
  const inactive = Object.create(ctx) as Context
  Object.defineProperty(inactive, 'tools', {
    get() { throw new Error('cannot get required service "tools" in inactive context') },
  })
  return inactive
}

it('keeps the retained registry for log shaping after its context becomes inactive', async () => {
  const h = await setup()
  let shaped = 0
  h.ctx.on('tools/ptc-dispatch-log', async (_dispatch, next) => {
    shaped += 1
    return next()
  })
  await appendSubDispatch(inactiveContext(h.ctx), h.ctx.tools, h.agent, h.settlement)
  expect(shaped).toBe(1)
  expect(h.session.snapshotEvents().map(event => event.type)).toEqual(['tool/ptc-dispatch'])
})

it('records nothing for a nested dispatch without an agent', async () => {
  const h = await setup()
  appendSubDispatchStart(undefined, {
    rootCallId: h.parent.rootCallId,
    parentCallId: h.parent.callId,
    subCallId: ToolCallId('outer-call:test:1'),
    name: 'inner-tool',
    arguments: {},
  })
  await appendSubDispatch(h.ctx, h.ctx.tools, undefined, h.settlement)
  expect(h.session.snapshotEvents()).toEqual([])
})
