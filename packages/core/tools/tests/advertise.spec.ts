/** Registration-level advertisement separates model declarations from admission and lookup. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const TEST_MODEL_SELECTION = { provider: 'test', model: 'test' }
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { id: SessionId('advertise') } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const controller = new AbortController()
  let calls = 0
  const tool = defineTool({
    name: 'hidden',
    description: 'A registration withheld from model declarations.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { calls++; return 'done' },
  })
  const input = { agent, name: tool.name, arguments: {}, callId: ToolCallId('call'), signal: controller.signal }
  const execute = (overrides: Partial<ToolExecutionInput> = {}): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { ...input, ...overrides })
  const resolve = () => ctx.tools.resolve({ agent, modelSelection: TEST_MODEL_SELECTION, signal: controller.signal })
  return { ctx, agent, scope, controller, tool, input, execute, resolve, calls: () => calls }
}

it('advertises registrations by default', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  expect(h.ctx.tools.schemas().map(schema => schema.name)).toEqual(['hidden'])
  expect(h.ctx.tools.definitions().map(definition => definition.name)).toEqual(['hidden'])
  expect(h.ctx.tools.get('hidden')?.name).toBe('hidden')
  expect(h.ctx.tools.executable('hidden')?.name).toBe('hidden')
})

it('keeps a non-advertised registration out of model declarations while lookup, admission, and execution retain it', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { advertise: false })
  expect(h.ctx.tools.schemas()).toEqual([])
  expect(h.ctx.tools.definitions()).toEqual([])
  expect(h.ctx.tools.get('hidden')?.name).toBe('hidden')
  expect(h.ctx.tools.executable('hidden')?.name).toBe('hidden')
  const toolSet = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, toolSet)).toEqual([])
  expect(h.ctx.tools.definitions(h.agent, toolSet)).toEqual([])
  expect(h.ctx.tools.get('hidden', h.agent, toolSet)?.name).toBe('hidden')
  expect((await h.execute({ toolSet })).isError).toBe(false)
  expect(h.calls()).toBe(1)
})

it('combines advertisement with a step-time activation condition', async () => {
  const h = await setup()
  let enabled = false
  h.ctx.tools.register(h.tool, { advertise: false, when: () => enabled })
  expect(h.ctx.tools.executable('hidden')).toBeUndefined()
  const unavailable = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, unavailable)).toEqual([])
  expect((await h.execute({ toolSet: unavailable })).error?.info?.code).toBe('UNKNOWN_TOOL')
  enabled = true
  const available = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, available)).toEqual([])
  expect(h.ctx.tools.get('hidden', h.agent, available)?.name).toBe('hidden')
  expect((await h.execute({ toolSet: available })).isError).toBe(false)
  expect(h.calls()).toBe(1)
})

it('does not let an allow-list re-advertise a non-advertised registration', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { advertise: false })
  const lift = h.scope.ctx.tools.restrict({ allow: ['hidden'] })
  expect(h.ctx.tools.schemas(h.agent)).toEqual([])
  expect(h.ctx.tools.get('hidden', h.agent)?.name).toBe('hidden')
  lift()
})

it('denies a non-advertised registration through live restrictions', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { advertise: false })
  const lift = h.scope.ctx.tools.restrict({ deny: ['hidden'] })
  expect(h.ctx.tools.get('hidden', h.agent)).toBeUndefined()
  expect(h.ctx.tools.executable('hidden', h.agent)).toBeUndefined()
  expect((await h.execute({ toolSet: await h.resolve() })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(0)
  lift()
  expect((await h.execute({ toolSet: await h.resolve() })).isError).toBe(false)
})

it('unregisters a non-advertised registration at its disposer', async () => {
  const h = await setup()
  const unregister = h.ctx.tools.register(h.tool, { advertise: false })
  expect(h.ctx.tools.get('hidden')?.name).toBe('hidden')
  unregister()
  expect(h.ctx.tools.get('hidden')).toBeUndefined()
  expect(h.ctx.tools.schemas()).toEqual([])
})
