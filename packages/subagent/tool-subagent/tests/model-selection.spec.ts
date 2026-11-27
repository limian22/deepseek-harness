import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from '../src/model-selection.ts'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'

const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

function parentWithRoute(
  options: Agent['options'] = {
    provider: 'alpha',
    model: 'parent-model',
    reasoningEffort: ReasoningEffortId('high'),
  },
): Agent {
  const id = SessionId('parent-with-route')
  return { id, options, session: Session.create(id) } as unknown as Agent
}

/** Record the durable Session route policy that the Host settings service would append. */
function recordPolicy(agent: Agent, routes: readonly { provider: string; model: string }[]): void {
  agent.session.append('subagent/model-selection-policy', {
    allowedModels: routes.map(route => ({ ...route })),
  })
}

describe('dsh-tool-subagent model selection', () => {
  it('rejects empty route ids at the configuration boundary', () => {
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes([{ provider: 'provider', model: '' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes({ provider: 'provider', model: 'model' }) })
      .toThrow('requires an array of routes')
    expect(() => { assertAllowedModelRoutes([{ provider: 1, model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
  })

  it('checks complete explicit routes against Session authorization or the current parent route', () => {
    const policy = { routes: [{ provider: 'alpha', model: 'allowed-model' }] }
    const parent = { provider: 'alpha', model: 'parent-model' }
    expect(() => {
      assertAllowedModelSelection(policy, parent, { provider: 'alpha', model: 'allowed-model' })
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(policy, parent, parent)
    }).toThrow('alpha/parent-model')
    expect(() => {
      assertAllowedModelSelection(undefined, parent, parent)
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(undefined, parent, { provider: 'alpha', model: 'other-model' })
    }).toThrow('explicit selection is limited to the parent route')
  })

  it('resolves an omitted route inside the recorded allowlist instead of inheriting an outside parent route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', withModelSelection: true },
      { onStart: (request) => { requests.push(request) } },
    )
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = {
      provider: 'deployment-provider',
      model: 'deployment-model',
    }
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'default route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'allowed-model' })
  })
  it('resolves a single allowed route for an omitted call whose parent route is outside the policy', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    }, { onStart: (request) => { requests.push(request) } })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [{ provider: 'deepseek', model: 'flash-model' }])
    const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
    ctx.llm.registerAdapter(['deepseek'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'allowed route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'deepseek', model: 'flash-model' })
    expect(resolve).toHaveBeenCalledWith(
      { provider: 'deepseek', model: 'flash-model' },
      expect.any(AbortSignal),
    )
    const child = resolveChildAgentOptions(parent, requests[0]?.agentOptions, 1)
    expect(child).toMatchObject({ provider: 'deepseek', model: 'flash-model' })
    expect(child.reasoningEffort).toBeUndefined()
  })

  it('keeps an allowed configured route and effort instead of the parent route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      agentOptions: {
        provider: 'alpha',
        model: 'configured-model',
        reasoningEffort: ReasoningEffortId('low'),
      },
    }, { onStart: (request) => { requests.push(request) } })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [
      { provider: 'alpha', model: 'allowed-model' },
      { provider: 'alpha', model: 'configured-model' },
      { provider: 'alpha', model: 'parent-model' },
    ])
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const result = await callSubagent(ctx, { description: 'configured route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'configured-model',
      reasoningEffort: ReasoningEffortId('low'),
    })
  })

  it('prefers an allowed parent route over the first allowed route when the configured route is not allowed', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      agentOptions: {
        provider: 'alpha',
        model: 'configured-model',
        reasoningEffort: ReasoningEffortId('low'),
      },
    }, { onStart: (request) => { requests.push(request) } })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [
      { provider: 'deepseek', model: 'flash-model' },
      { provider: 'alpha', model: 'parent-model' },
    ])
    const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const result = await callSubagent(ctx, { description: 'parent route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    const requested = requests[0]?.agentOptions
    expect(requested).toEqual({ provider: 'alpha', model: 'parent-model' })
    const child = resolveChildAgentOptions(parent, requested, 1)
    expect(child.reasoningEffort).toBe(ReasoningEffortId('high'))
    expect(resolve).toHaveBeenCalledWith(
      { provider: 'alpha', model: 'parent-model', reasoningEffort: ReasoningEffortId('high') },
      expect.any(AbortSignal),
    )
  })

  it('uses the first allowed route when neither the configured route nor the parent route is allowed', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
      agentOptions: { provider: 'alpha', model: 'configured-model' },
    }, { onStart: (request) => { requests.push(request) } })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [
      { provider: 'gamma', model: 'second-model' },
      { provider: 'alpha', model: 'allowed-model' },
    ])
    ctx.llm.registerAdapter(['gamma'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'first route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'gamma', model: 'second-model' })
  })

  it('preserves non-LLM options and clears configured effort when the policy changes the route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      agentOptions: {
        provider: 'alpha',
        model: 'configured-model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 321,
      },
    }, { onStart: (request) => { requests.push(request) } })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [{ provider: 'deepseek', model: 'flash-model' }])
    const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
    ctx.llm.registerAdapter(['deepseek'], new MockAdapter([], REASONING))

    const result = await callSubagent(ctx, { description: 'replaced route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    const requested = requests[0]?.agentOptions
    expect(requested).toEqual({ provider: 'deepseek', model: 'flash-model', maxTokens: 321 })
    expect(resolve).toHaveBeenCalledWith(
      { provider: 'deepseek', model: 'flash-model' },
      expect.any(AbortSignal),
    )
    const child = resolveChildAgentOptions(parent, requested, 1)
    expect(child.maxTokens).toBe(321)
    expect(child.reasoningEffort).toBeUndefined()
  })

  it('resolves a partial configured route through the policy instead of failing', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
      agentOptions: { provider: 'alpha', maxTokens: 321 },
    }, { onStart: (request) => { requests.push(request) } })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [
      { provider: 'alpha', model: 'parent-model' },
      { provider: 'deepseek', model: 'flash-model' },
    ])
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const result = await callSubagent(ctx, { description: 'partial route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'parent-model',
      maxTokens: 321,
    })
  })

  it('keeps a provider route default that the recorded policy allows', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'child-model' },
      onStart: (request) => { requests.push(request) },
    })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [
      { provider: 'alpha', model: 'parent-model' },
      { provider: 'alpha', model: 'child-model' },
    ])
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const result = await callSubagent(ctx, { description: 'provider default', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'child-model' })
  })

  it('keeps provider route default effort semantics when the default equals the parent route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'parent-model' },
      onStart: (request) => { requests.push(request) },
    })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [{ provider: 'alpha', model: 'parent-model' }])
    const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
    // The provider default has no declared reasoning support: inheriting the
    // parent effort here would reject a route the backend can actually run.
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'provider default', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    const requested = requests[0]?.agentOptions
    expect(requested).toEqual({ provider: 'alpha', model: 'parent-model' })
    expect(resolve).toHaveBeenCalledWith(
      { provider: 'alpha', model: 'parent-model' },
      expect.any(AbortSignal),
    )
    const child = resolveChildAgentOptions(parent, requested, 1)
    expect(child).toMatchObject({ provider: 'alpha', model: 'parent-model' })
    expect(child.reasoningEffort).toBeUndefined()
  })

  it('does not carry a provider route default into a different allowed route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      historicalPolicyOnly: true,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'child-model' },
      onStart: (request) => { requests.push(request) },
    })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [{ provider: 'deepseek', model: 'flash-model' }])
    const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
    ctx.llm.registerAdapter(['deepseek'], new MockAdapter([], REASONING))

    const result = await callSubagent(ctx, { description: 'replaced default', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'deepseek', model: 'flash-model' })
    expect(resolve).toHaveBeenCalledWith(
      { provider: 'deepseek', model: 'flash-model' },
      expect.any(AbortSignal),
    )
  })

  it('fails closed for an empty recorded policy and keeps the no-policy fallback', () => {
    const parent = { provider: 'alpha', model: 'parent-model' }
    expect(() => requestedAgentOptions(undefined, {}, true, { routes: [] }, parent))
      .toThrow('allows no routes')
    expect(() => requestedAgentOptions({ provider: 'alpha', model: 'parent-model' }, {}, false, { routes: [] }, parent))
      .toThrow('allows no routes')
    const configured = { provider: 'alpha', model: 'configured-model' }
    expect(requestedAgentOptions(configured, {}, true, undefined, parent)).toBe(configured)
  })

  it('allows a fixed-route backend to use its own route despite a recorded policy', async () => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock' }, {
      capabilities: { agentOptions: false },
      onStart: started,
    })
    const parent = modelSelectionSetupAgent(ctx)
    recordPolicy(parent, [{ provider: 'alpha', model: 'allowed-model' }])

    const result = await callSubagent(ctx, { description: 'fixed route', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(started).toHaveBeenCalledOnce()
  })

  it('keeps existing omitted fallback behavior without a recorded policy', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      hostSelectionEnabled: false,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
    }, { onStart: (request) => { requests.push(request) } })
    const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')

    const result = await callSubagent(ctx, { description: 'no policy', prompt: 'do it' })

    expect(result.isError, text(result)).toBe(false)
    expect(requests[0]?.agentOptions).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })
  it('exposes Session-authorized route fields and discovery when selection is enabled', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'cwd',
      'description',
      'model',
      'name',
      'prompt',
      'provider',
      'reasoning_effort',
    ])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(schema.description).not.toContain('Changing the route can prevent provider-side reuse')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()
    expect(schema.description).not.toContain('alpha')

    const registration = ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const definition = ctx.tools.get('subagent', agent)
    registration.replace(['beta'])
    expect(ctx.tools.get('subagent', agent)).toBe(definition)
    expect(definition?.description).not.toContain('beta')
  })

  it('rejects route arguments for a backend without Agent options support', async () => {
    const ctx = await setup({ provider: 'mock' }, { capabilities: { agentOptions: false } })
    const result = await callSubagent(ctx, {
      description: 'unsupported route', prompt: 'do it', provider: 'alpha', model: 'parent-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('model selection is disabled for this tool instance')
  })

  it('hides and rejects route fields without modelSelection', async () => {
    const ctx = await setup({ provider: 'mock', parentAgentOptions: { provider: 'alpha', model: 'parent-model' } })
    const schema = ctx.tools.schemas().find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['cwd', 'description', 'name', 'prompt'])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()

    for (const selection of [
      { provider: 'alpha', model: 'parent-model' },
      { reasoning_effort: 'low' },
    ]) {
      const result = await callSubagent(ctx, { description: 'forced route', prompt: 'do it', ...selection })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('child model selection is disabled for this tool instance')
    }
  })

  it('shows discovery guidance only while its tool is visible, regardless of mount order', async () => {
    const ctx = await setup({ provider: 'mock', modelSelection: true })
    const agent = modelSelectionSetupAgent(ctx)
    const descriptions = () => ctx.tools.schemas(agent).map(schema => schema.description).join('\n')
    const guidance = 'Inspect the routes available for explicit subagent model selection.'
    expect(descriptions()).not.toContain(guidance)
    expect(descriptions()).not.toContain('list_subagent_models')

    const discovery = await ctx.plugin(tool, { provider: 'mock', toolName: 'discovery_subagent', modelDiscovery: true })
    expect(descriptions()).toContain(guidance)
    const restore = agent.ctx.tools.restrict({ deny: ['list_subagent_models'] })
    expect(descriptions()).not.toContain(guidance)
    restore()
    expect(descriptions()).toContain(guidance)
    await discovery.dispose()
    expect(descriptions()).not.toContain(guidance)
  })

  it.each(['configured', 'provider'] as const)('rejects effort-only selection despite %s route defaults', async (source) => {
    const defaults = { provider: 'alpha', model: 'configured-model' }
    const start = vi.fn()
    const ctx = await setup({
      provider: 'mock', modelSelection: true,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
      ...source === 'configured' ? { agentOptions: defaults } : {},
    }, {
      onStart: start,
      ...source === 'provider' ? { agentRouteDefaults: defaults } : {},
    })
    const result = await callSubagent(ctx, {
      description: 'adjust effort', prompt: 'work', reasoning_effort: 'low',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`reasoning_effort` requires both `provider` and `model`')
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps settings-owned route fields visible but rejects other routes without a Session policy', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      hostSelectionEnabled: false,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
    })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['cwd', 'description', 'model', 'name', 'prompt', 'provider', 'reasoning_effort'])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(schema.description).not.toContain('Changing the route can prevent provider-side reuse')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()

    const result = await callSubagent(ctx, {
      description: 'forced route',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed for this Session')
  })

  it('discovers only the parent route without a Session policy and permits its explicit route and effort', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      hostSelectionEnabled: false,
      parentAgentOptions: parentWithRoute().options,
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha', 'other-provider'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    const discover = (args: unknown) => executeToolFixture(ctx, {
      callId: ToolCallId('default-model-discovery'), name: 'list_subagent_models',
      arguments: args, agent: parent, signal: new AbortController().signal,
    })
    expect(text(await discover({}))).toContain('alpha')
    expect(text(await discover({}))).not.toContain('other-provider')
    expect(text(await discover({ provider: 'alpha' }))).toContain('alpha/parent-model')
    expect(text(await discover({ provider: 'alpha', model: 'parent-model' }))).toContain('low')
    expect((await discover({ provider: 'alpha', model: 'other-model' })).isError).toBe(true)

    const omitted = await callSubagent(ctx, { description: 'inherit', prompt: 'work' })
    expect(omitted.isError, text(omitted)).toBe(false)
    expect(requests[0]?.agentOptions).toBeUndefined()
    const explicit = await callSubagent(ctx, {
      description: 'same route', prompt: 'work', provider: 'alpha', model: 'parent-model',
    })
    expect(explicit.isError, text(explicit)).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({ provider: 'alpha', model: 'parent-model' })
    const effort = await callSubagent(ctx, { description: 'effort', prompt: 'work', provider: 'alpha', model: 'parent-model', reasoning_effort: 'low' })
    expect(effort.isError, text(effort)).toBe(false)
    expect(requests[2]?.agentOptions).toEqual({ provider: 'alpha', model: 'parent-model', reasoningEffort: 'low' })
    const rejected = await callSubagent(ctx, {
      description: 'other route', prompt: 'work', provider: 'alpha', model: 'other-model',
    })
    expect(rejected.isError).toBe(true)
    expect(requests).toHaveLength(3)
  })

  it('rejects enabled model selection when the provider cannot apply Agent options', async () => {
    await expect(setup(
      { provider: 'mock', withModelSelection: true, maxDepth: 'provider-managed' },
      { capabilities: { agentOptions: false } },
    )).rejects.toThrow('provider "mock" does not support child model selection')
  })

  it('selects an unlisted complete route and clears a configured effort when the route changes', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: {
        provider: 'alpha',
        model: 'configured-model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 321,
      },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

    const selected = await callSubagent(ctx, {
      description: 'route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'unlisted-model',
    })
    expect(selected.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'unlisted-model',
      maxTokens: 321,
    })

    const effort = await callSubagent(ctx, {
      description: 'same route effort',
      prompt: 'do it',
      provider: 'alpha',
      model: 'configured-model',
      reasoning_effort: 'low',
    })
    expect(effort.isError).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'configured-model',
      reasoningEffort: 'low',
      maxTokens: 321,
    })
  })

  it.each([
    {},
    { provider: 'alpha' },
    { model: 'parent-model' },
  ])('rejects reasoning effort without a complete explicit route: %j', async (route) => {
    const start = vi.fn()
    const ctx = await setup({
      provider: 'mock', withModelSelection: true, parentAgentOptions: parentWithRoute().options,
    }, { onStart: start })
    const lookup = vi.spyOn(ctx.llm, 'resolveCallConfig')
    const result = await callSubagent(ctx, {
      description: 'effort work', prompt: 'do it', reasoning_effort: 'low', ...route,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`provider` and `model`')
    expect(lookup).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it.each(['parent', 'configured', 'different-configured'] as const)(
    'uses model-default effort for an explicit parent route despite %s effort', async (source) => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        parentAgentOptions: parentWithRoute().options,
        ...source === 'parent' ? {} : {
          agentOptions: {
            provider: 'alpha',
            model: source === 'configured' ? 'parent-model' : 'configured-model',
            reasoningEffort: ReasoningEffortId('high'),
          },
        },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
        ...REASONING, defaultEffort: ReasoningEffortId('low'),
      }))
      const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
      const result = await callSubagent(ctx, {
        description: 'same route work', prompt: 'do it', provider: 'alpha', model: 'parent-model',
      })
      expect(result.isError, text(result)).toBe(false)
      expect(resolve).toHaveBeenCalledWith({ provider: 'alpha', model: 'parent-model' }, expect.any(AbortSignal))
      const requested = requests[0]!.agentOptions
      expect(requested).toEqual({ provider: 'alpha', model: 'parent-model' })
      const child = resolveChildAgentOptions(modelSelectionSetupAgent(ctx), requested, 1)
      expect(child.reasoningEffort).toBeUndefined()
      expect(await ctx.llm.resolveCallConfig({
        provider: 'alpha', model: 'parent-model',
        ...child.reasoningEffort === undefined ? {} : { reasoningEffort: child.reasoningEffort },
      }))
        .toMatchObject({ reasoningEffort: 'low' })
    },
  )

  it.each([undefined, 'parent-model', 'configured-model'])(
    'preserves configured or inherited selection when all fields are omitted: %s', async (model) => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock', withModelSelection: true,
        parentAgentOptions: parentWithRoute().options,
        ...model === undefined ? {} : { agentOptions: { provider: 'alpha', model } },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const result = await callSubagent(ctx, { description: 'default child', prompt: 'work' })
      expect(result.isError, text(result)).toBe(false)
      const child = resolveChildAgentOptions(modelSelectionSetupAgent(ctx), requests[0]!.agentOptions, 1)
      expect(child.model).toBe(model ?? 'parent-model')
      expect(child.reasoningEffort).toBe(model === 'configured-model' ? undefined : 'high')
    },
  )

  it('compares explicit routes with the latest logged parent selection', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { reasoningEffort: ReasoningEffortId('high') },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['current-provider'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = {
      provider: 'created-provider', model: 'created-model',
    }
    parent.session.append('request/header', {
      header: { config: { provider: 'current-provider', model: 'current-model' } },
      reason: 'initial',
    })

    const result = await callSubagent(ctx, {
      description: 'same current route',
      prompt: 'do it',
      provider: 'current-provider',
      model: 'current-model',
    })

    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'current-provider',
      model: 'current-model',
    })
  })

  it('rejects an effort without any effective route', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const result = await callSubagent(ctx, {
      description: 'missing route',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`reasoning_effort` requires both `provider` and `model`')
  })

  it('rejects preflight without an effective provider and model', async () => {
    const ctx = await setup({ provider: 'mock' })
    await expect(preflightChildLlmRoute(ctx.llm, {}, undefined, AbortSignal.abort()))
      .rejects.toThrow('without an effective provider and model')
  })

  it.each([
    { provider: 'alpha' },
    { model: 'fast-model' },
  ])('rejects a partial model-facing route before child creation', async (route) => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const result = await callSubagent(ctx, { description: 'partial route', prompt: 'do it', ...route })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`provider` and `model` must be supplied together')
    expect(starts).toBe(0)
  })

  it.each([
    { provider: '', model: 'fast-model', expected: '`provider` must be non-empty' },
    { provider: 'alpha', model: '', expected: '`model` must be non-empty' },
    { reasoning_effort: '', expected: '`reasoning_effort` must be non-empty' },
  ])('rejects empty model-facing values', async ({ expected, ...selection }) => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const result = await callSubagent(ctx, { description: 'empty route', prompt: 'do it', ...selection })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
  })

  it('uses the LLM runtime for provider and reasoning-effort validation before child creation', async () => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const unsupported = await callSubagent(ctx, {
      description: 'bad effort',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
      reasoning_effort: 'max',
    })
    expect(unsupported.isError).toBe(true)
    expect(text(unsupported)).toContain('does not support reasoning effort "max"')

    const missing = await callSubagent(ctx, {
      description: 'bad provider',
      prompt: 'do it',
      provider: 'missing',
      model: 'fast-model',
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no adapter registered for provider "missing"')
    expect(starts).toBe(0)
  })

  it('validates a configured effort before child creation', async () => {
    let starts = 0
    const ctx = await setup({
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
      defaultEffort: ReasoningEffortId('low'),
    }))

    const result = await callSubagent(
      ctx,
      { description: 'same route', prompt: 'do it' },
      { agent: parentWithRoute() },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support reasoning effort "high"')
    expect(starts).toBe(0)
  })

  it('validates a configured route before child creation', async () => {
    let starts = 0
    const ctx = await setup({
      provider: 'mock',
      agentOptions: { provider: 'missing', model: 'configured-model' },
    }, { onStart: () => { starts += 1 } })

    const result = await callSubagent(
      ctx,
      { description: 'configured route', prompt: 'do it' },
      { agent: parentWithRoute() },
    )

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no adapter registered for provider "missing"')
    expect(starts).toBe(0)
  })

  it('rejects selected routes or configured efforts when the LLM service is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, {
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'fast-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    })

    const configured = await callSubagent(ctx, { description: 'configured effort', prompt: 'do it' }, { agent: parentWithRoute() })
    expect(configured.isError).toBe(true)
    expect(text(configured)).toContain('`llm` service is unavailable')

  })

  it('keeps pure inherited routing usable without resolving an LLM route', async () => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock' }, { onStart: started })
    const adapter = new MockAdapter([])
    const resolve = vi.spyOn(adapter, 'resolveModel')
    ctx.llm.registerAdapter(['alpha'], adapter)

    const result = await callSubagent(ctx, { description: 'inherit route', prompt: 'do it' })
    expect(result.isError).toBe(false)
    expect(started).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('enforces Session authorization when a fork tool explicitly enables model selection', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, {
      inheritsParentContext: true,
      onStart: (request) => { requests.push(request) },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('list_subagent_models')
    expect(schema.description).toContain('Changing the route can prevent provider-side reuse of the inherited conversation prefix.')

    const allowed = await callSubagent(ctx, {
      description: 'fork work', prompt: 'do it', provider: 'alpha', model: 'fast-model', reasoning_effort: 'low',
    })
    expect(allowed.isError, text(allowed)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha', model: 'fast-model', reasoningEffort: ReasoningEffortId('low'),
    })

    const denied = await callSubagent(ctx, {
      description: 'unauthorized route', prompt: 'do it', provider: 'alpha', model: 'denied-model',
    })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('is not allowed for this Session')

    const invalidEffort = await callSubagent(ctx, {
      description: 'unsupported effort', prompt: 'do it', provider: 'alpha', model: 'fast-model', reasoning_effort: 'invalid',
    })
    expect(invalidEffort.isError).toBe(true)
    expect(text(invalidEffort)).toContain('invalid')
    expect(requests).toHaveLength(1)
  })

  it('constrains omitted fork routes by the Session policy without exposing route fields', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
    }, {
      inheritsParentContext: true,
      onStart: (request) => { requests.push(request) },
    })
    const agent = modelSelectionSetupAgent(ctx)
    recordPolicy(agent, [{ provider: 'deepseek', model: 'flash-model' }])
    ctx.llm.registerAdapter(['deepseek'], new MockAdapter([], REASONING))
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['cwd', 'description', 'name', 'prompt'])
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeUndefined()

    for (const selection of [
      { provider: 'alpha', model: 'fast-model' },
      { reasoning_effort: 'high' },
    ]) {
      const result = await callSubagent(ctx, { description: 'fork work', prompt: 'do it', ...selection })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('model selection is disabled for this tool instance')
    }
    expect(requests).toHaveLength(0)

    const inherited = await callSubagent(ctx, { description: 'fork work', prompt: 'do it' })
    expect(inherited.isError, text(inherited)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'deepseek', model: 'flash-model' })
  })

  it('propagates an exact-route resolver failure before child creation', async () => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const adapter = new MockAdapter([])
    vi.spyOn(adapter, 'resolveModel').mockRejectedValue(new Error('selected route unavailable'))
    ctx.llm.registerAdapter(['alpha'], adapter)

    const result = await callSubagent(ctx, {
      description: 'route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('selected route unavailable')
    expect(starts).toBe(0)
  })
})
