import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { applySubagentModel } from '../src/set-model.ts'

function target(current: Readonly<ModelSelection> | undefined) {
  const selected: ModelSelection[] = []
  return {
    selected,
    target: {
      current: () => current,
      select: (selection: ModelSelection) => { selected.push(selection) },
    },
  }
}

const resolves = { resolveCallConfig: async () => undefined }

describe('applySubagentModel', () => {
  it('applies a route the Session authorizes for children', async () => {
    const { target: agent, selected } = target({ provider: 'magpie', model: 'auto/deepseek-v4.1-flash' })
    const change = await applySubagentModel(resolves, agent, [{ provider: 'magpie', model: 'auto/deepseek-v4-pro' }], {
      provider: 'magpie',
      model: 'auto/deepseek-v4-pro',
    })
    expect(change).toEqual({
      provider: 'magpie',
      model: 'auto/deepseek-v4-pro',
      changed: true,
    })
    expect(selected).toHaveLength(1)
  })

  it('refuses a route outside the recorded allowlist and names the allowed ones', async () => {
    const { target: agent, selected } = target({ provider: 'magpie', model: 'auto/deepseek-v4.1-flash' })
    await expect(applySubagentModel(resolves, agent, [{ provider: 'magpie', model: 'auto/deepseek-v4.1-flash' }], {
      provider: 'anthropic',
      model: 'claude-fable-5',
    })).rejects.toThrow('outside the routes this Session authorizes for children: magpie/auto/deepseek-v4.1-flash')
    expect(selected).toHaveLength(0)
  })

  it('accepts any configured route when the Session records no allowlist', async () => {
    const { target: agent, selected } = target(undefined)
    const change = await applySubagentModel(resolves, agent, undefined, { provider: 'magpie', model: 'auto/deepseek-v4-pro' })
    expect(change.changed).toBe(true)
    expect(selected).toHaveLength(1)
  })

  it('reports an unchanged route without writing a new selection', async () => {
    const { target: agent, selected } = target({ provider: 'magpie', model: 'auto/deepseek-v4-pro' })
    const change = await applySubagentModel(resolves, agent, undefined, { provider: 'magpie', model: 'auto/deepseek-v4-pro' })
    expect(change.changed).toBe(false)
    expect(selected).toHaveLength(0)
  })

  it('surfaces a route the deployment cannot resolve before touching the agent', async () => {
    const { target: agent, selected } = target(undefined)
    const failing = { resolveCallConfig: vi.fn(async () => { throw new Error('no adapter serves this model') }) }
    await expect(applySubagentModel(failing, agent, undefined, { provider: 'magpie', model: 'ghost' }))
      .rejects.toThrow('no adapter serves this model')
    expect(selected).toHaveLength(0)
  })
})
