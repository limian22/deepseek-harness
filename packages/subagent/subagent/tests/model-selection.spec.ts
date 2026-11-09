/**
 * Session model-selection policy: the durable authorization moves with the
 * subagent seam, and `startActivation` admits every child LLM route through it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import {
  AllowedModelRoute,
  ModelSelectionPolicy,
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  firstAllowedRoute,
  modelRouteKey,
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '../src/model-selection.ts'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const FLASH: AllowedModelRoute = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const GPT: AllowedModelRoute = { provider: 'openai', model: 'gpt-5' }

const AGENT_OPTIONS: SubagentCapabilities = {
  agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false,
}
const FIXED_RUNTIME: SubagentCapabilities = {
  agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false,
}

const COMPLETED: SubagentResult = { output: [], stopReason: 'completed' }

/** Record the exact start request and settle immediately without creating a child. */
class RouteRecordingProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  readonly runs: SubagentStartRequest[] = []
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>

  constructor(
    readonly name: string,
    readonly capabilities: SubagentCapabilities,
    routeDefaults?: Readonly<{ provider: string; model: string }>,
  ) {
    if (routeDefaults !== undefined) this.agentRouteDefaults = routeDefaults
  }

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.runs.push(request)
    const run: SubagentRun = {
      id: SessionId(`${this.name}-child-${this.runs.length}`),
      result: Promise.resolve(COMPLETED),
      dispose: () => Promise.resolve(),
    }
    return Promise.resolve(run)
  }
}

async function setup(options?: {
  capabilities?: SubagentCapabilities
  routeDefaults?: Readonly<{ provider: string; model: string }>
  parentOptions?: AgentOptions
}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const parent = await externalTestParent(ctx)
  if (options?.parentOptions !== undefined) {
    ;(parent as { options: AgentOptions }).options = options.parentOptions
  }
  const provider = new RouteRecordingProvider(
    'route-recorder',
    options?.capabilities ?? AGENT_OPTIONS,
    options?.routeDefaults,
  )
  ctx.subagents.registerProvider(provider)
  return { ctx, parent, provider }
}

function recordPolicy(parent: Agent, routes: readonly AllowedModelRoute[]): void {
  parent.session.append('subagent/model-selection-policy', { allowedModels: routes.map(route => ({ ...route })) })
}

function start(ctx: Context, parent: Agent, agentOptions?: AgentOptions) {
  return ctx.subagents.startActivation({
    provider: 'route-recorder',
    label: 'Route work',
    signal: new AbortController().signal,
    delivery: 'caller',
    parent,
    prompt: [{ type: 'text', text: 'Do the work' }],
    ...agentOptions === undefined ? {} : { agentOptions },
  })
}

describe('session model-selection policy primitives', () => {
  it('identifies exact routes and rejects malformed or duplicate policy entries', () => {
    expect(modelRouteKey(FLASH)).toBe('deepseek-official\0deepseek-v4-flash')
    expect(() => { assertAllowedModelRoutes([FLASH, { ...FLASH }]) })
      .toThrow('subagent model selection repeats route "deepseek-official/deepseek-v4-flash"')
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'm' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes({ provider: 'p', model: 'm' }) })
      .toThrow('requires an array of routes')
  })

  it('checks explicit selections against the policy or the parent route without one', () => {
    const policy: ModelSelectionPolicy = { routes: [FLASH] }
    expect(() => { assertAllowedModelSelection(policy, GPT, FLASH) }).not.toThrow()
    expect(() => { assertAllowedModelSelection(policy, GPT, GPT) })
      .toThrow('child LLM route "openai/gpt-5" is not allowed for this Session')
    expect(() => { assertAllowedModelSelection(undefined, GPT, GPT) }).not.toThrow()
    expect(() => { assertAllowedModelSelection(undefined, GPT, FLASH) })
      .toThrow('; without a recorded model-selection policy, explicit selection is limited to the parent route')
  })

  it('resolves the implicit route from configured, then parent, then the first listed route', () => {
    const policy: ModelSelectionPolicy = { routes: [FLASH, GPT] }
    expect(firstAllowedRoute(policy, [GPT, { provider: 'openai', model: 'gpt-5-mini' }]))
      .toEqual(GPT)
    expect(firstAllowedRoute(policy, [{ provider: 'openai', model: 'gpt-5-mini' }, { model: 'x' }]))
      .toEqual(FLASH)
    expect(firstAllowedRoute(policy, [])).toEqual(FLASH)
    expect(() => { firstAllowedRoute({ routes: [] }, [{ provider: 'openai', model: 'gpt-5-mini' }]) })
      .toThrow('subagent model selection policy allows no routes')
  })

  it('reads the recorded policy from the Session projection', async () => {
    const { ctx, parent } = await setup()
    const handle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    expect(subagentModelSelectionPolicy(handle, parent.session)).toBeUndefined()
    recordPolicy(parent, [FLASH])
    expect(subagentModelSelectionPolicy(handle, parent.session)).toEqual([FLASH])
  })
})

describe('startActivation model-selection admission', () => {
  it('keeps an allowed declared route unchanged', async () => {
    const { ctx, parent, provider } = await setup({ parentOptions: { provider: GPT.provider, model: GPT.model } })
    recordPolicy(parent, [FLASH])
    await start(ctx, parent, { provider: FLASH.provider, model: FLASH.model })
    expect(provider.runs[0]?.agentOptions).toEqual({ provider: FLASH.provider, model: FLASH.model })
  })

  it('rejects a declared route outside the policy before creating a child', async () => {
    const { ctx, parent, provider } = await setup({ parentOptions: { provider: GPT.provider, model: GPT.model } })
    recordPolicy(parent, [FLASH])
    await expect(start(ctx, parent, { provider: GPT.provider, model: GPT.model }))
      .rejects.toThrow('child LLM route "openai/gpt-5" is not allowed for this Session')
    expect(provider.runs).toHaveLength(0)
  })

  it('resolves an omitted route to the first listed route instead of an unlisted parent', async () => {
    const { ctx, parent, provider } = await setup({ parentOptions: { provider: GPT.provider, model: GPT.model } })
    recordPolicy(parent, [FLASH])
    await start(ctx, parent)
    expect(provider.runs[0]?.agentOptions).toEqual({ provider: FLASH.provider, model: FLASH.model })
  })

  it('reuses the parent route when the policy lists it', async () => {
    const { ctx, parent, provider } = await setup({ parentOptions: { provider: FLASH.provider, model: FLASH.model } })
    recordPolicy(parent, [FLASH])
    await start(ctx, parent)
    expect(provider.runs[0]?.agentOptions).toEqual({ provider: FLASH.provider, model: FLASH.model })
  })

  it('uses allowed provider route defaults, otherwise the first listed route', async () => {
    const allowed = await setup({ routeDefaults: FLASH })
    recordPolicy(allowed.parent, [FLASH])
    await start(allowed.ctx, allowed.parent)
    expect(allowed.provider.runs[0]?.agentOptions).toEqual({ provider: FLASH.provider, model: FLASH.model })

    const replaced = await setup({ routeDefaults: GPT })
    recordPolicy(replaced.parent, [FLASH])
    await start(replaced.ctx, replaced.parent)
    expect(replaced.provider.runs[0]?.agentOptions).toEqual({ provider: FLASH.provider, model: FLASH.model })
  })

  it('merges a partial declared route over the parent route before validating it', async () => {
    const { ctx, parent, provider } = await setup({ parentOptions: { provider: FLASH.provider, model: FLASH.model } })
    recordPolicy(parent, [FLASH])
    await start(ctx, parent, { provider: FLASH.provider })
    expect(provider.runs[0]?.agentOptions).toEqual({ provider: FLASH.provider, model: FLASH.model })

    const outOfPolicy = await setup({ parentOptions: { provider: GPT.provider, model: GPT.model } })
    recordPolicy(outOfPolicy.parent, [FLASH])
    await expect(start(outOfPolicy.ctx, outOfPolicy.parent, { provider: GPT.provider }))
      .rejects.toThrow('child LLM route "openai/gpt-5" is not allowed for this Session')
    expect(outOfPolicy.provider.runs).toHaveLength(0)
  })

  it('rejects a fixed-runtime backend that cannot honor the allowed models', async () => {
    const { ctx, parent, provider } = await setup({
      capabilities: FIXED_RUNTIME,
      parentOptions: { provider: GPT.provider, model: GPT.model },
    })
    recordPolicy(parent, [FLASH])
    await expect(start(ctx, parent))
      .rejects.toThrow("cannot honor this Session's allowed child models")
    expect(provider.runs).toHaveLength(0)
  })

  it('keeps existing behavior without a recorded policy', async () => {
    const { ctx, parent, provider } = await setup({ parentOptions: { provider: GPT.provider, model: GPT.model } })
    await start(ctx, parent)
    expect(provider.runs[0]?.agentOptions).toBeUndefined()
    await start(ctx, parent, { provider: 'any-provider', model: 'any-model' })
    expect(provider.runs[1]?.agentOptions).toEqual({ provider: 'any-provider', model: 'any-model' })
  })
})
