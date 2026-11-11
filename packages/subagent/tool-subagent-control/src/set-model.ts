/**
 * Ancestor-directed model routing for delegated agents.
 * The tree-scoped name resolution supplies the authorization (a caller can only
 * name its own descendants) and the Session's recorded allowlist bounds which
 * routes an ancestor may choose, so this tool adds no authority of its own.
 * @module @deepseek-ai/dsh-tool-subagent-control/set-model
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { subagentModelSelectionPolicy, subagentModelSelectionProjectionDefinition } from '@deepseek-ai/dsh-subagent'

/** Services the model-routing step needs. */
export interface SetSubagentModelServices {
  resolveCallConfig(selection: ModelSelection): Promise<unknown>
}

/** Live route owner the change is applied to. */
export interface SubagentModelTarget {
  current(): Readonly<ModelSelection> | undefined
  select(selection: ModelSelection): void
}

/** Applied routing change for one delegated agent. */
export interface SubagentModelChange {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly changed: boolean
}

/**
 * Re-route one live descendant's model, bounded by the routes its Session authorizes.
 * @param services - model resolution for the requested route.
 * @param target - the live route owner to change.
 * @param allowed - routes the target Session authorizes for children, or undefined when it records none.
 * @param requested - provider, model, and optional adapter-owned effort.
 * @returns the applied routing change and whether it differed from the current route.
 */
export async function applySubagentModel(
  services: SetSubagentModelServices,
  target: SubagentModelTarget,
  allowed: readonly { readonly provider: string; readonly model: string }[] | undefined,
  requested: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string },
): Promise<SubagentModelChange> {
  const selection: ModelSelection = {
    provider: requested.provider,
    model: requested.model,
    ...(requested.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(requested.reasoningEffort) }),
  }
  if (allowed !== undefined && !allowed.some(route => route.provider === selection.provider && route.model === selection.model)) {
    const offered = allowed.map(route => `${route.provider}/${route.model}`).join(', ')
    throw new Error(
      `model ${selection.provider}/${selection.model} is outside the routes this Session authorizes for children: ${offered}`,
    )
  }
  await services.resolveCallConfig(selection)
  const current = target.current()
  const changed = current?.provider !== selection.provider
    || current?.model !== selection.model
    || current?.reasoningEffort !== selection.reasoningEffort
  if (changed) target.select(selection)
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    changed,
  }
}

/**
 * Register `set_subagent_model`.
 * @param ctx - context carrying tools, subagents, live Agents, LLM resolution, and projections.
 */
export function registerSetSubagentModel(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'set_subagent_model',
    description:
      'Change the model a live subagent uses from its next turn on. '
      + 'The target must be your own descendant, and the route must be one the '
      + 'target Session authorizes for children. The change is recorded on that '
      + 'Session, leaves your default model untouched, and does not interrupt '
      + 'work already in progress.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'The name of an agent created under you: your direct child or a deeper descendant.',
      },
      provider: {
        type: 'string',
        required: true,
        description: 'Provider id of the model to use, as shown by list_subagent_models.',
      },
      model: {
        type: 'string',
        required: true,
        description: 'Provider-owned model id to use for that agent.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Optional reasoning effort id supported by the chosen model.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoningEffort: { type: 'string' },
          changed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.changed
          ? `agent ${value.agent} now uses ${value.provider}/${value.model}`
          : `agent ${value.agent} already uses ${value.provider}/${value.model}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('set_subagent_model requires a calling agent (exec.agent was undefined)')
      const targetId = await ctx.subagents.resolveName(caller, args.agent, exec.signal)
      const target = ctx.agents.get(targetId)
      if (target === undefined) {
        throw new Error(`subagent "${args.agent}" has no live agent; resume it before changing its model`)
      }
      const handle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      const allowed = subagentModelSelectionPolicy(handle, target.session)
      return applySubagentModel(
        { resolveCallConfig: selection => ctx.llm.resolveCallConfig(selection) },
        target.model,
        allowed,
        {
          provider: args.provider,
          model: args.model,
          ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }),
        },
      ).then(change => ({ agent: args.agent, ...change }))
    },
  }))
}
