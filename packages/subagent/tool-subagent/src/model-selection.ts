/** Child LLM route selection for the subagent tool. */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { assertAllowedModelSelection, firstAllowedRoute } from '@deepseek-ai/dsh-subagent'
import type { AllowedModelRoute, ModelSelectionPolicy } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'

export {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  firstAllowedRoute,
  modelRouteKey,
} from '@deepseek-ai/dsh-subagent'
export type { AllowedModelRoute, ModelSelectionPolicy } from '@deepseek-ai/dsh-subagent'

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
}

/**
 * Whether a call explicitly selects any child LLM value.
 * @param request - Model-facing route fields from the tool call.
 * @returns Whether at least one route or effort field is present.
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
}

/** Reject an empty model-facing route value at the tool JSON boundary. */
function assertNonEmpty(value: string | undefined, field: keyof DelegationModelRequest): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
}

/**
 * Apply the policy-selected route to configured child options. Keeping an
 * already-authorized configured route keeps its configured effort; otherwise
 * the configured route and its effort are replaced, while an omitted effort
 * lets child-option merging inherit the parent's only for an unchanged route.
 * @param configured - Tool-instance child defaults.
 * @param route - Route the recorded policy selected.
 * @returns Child options carrying the selected route.
 */
function withSelectedRoute(
  configured: AgentOptions | undefined,
  route: AllowedModelRoute,
): AgentOptions {
  if (configured !== undefined && configured.provider === route.provider && configured.model === route.model) {
    return configured
  }
  const { provider: _provider, model: _model, reasoningEffort: _reasoningEffort, ...rest } = configured ?? {}
  return { ...rest, provider: route.provider, model: route.model }
}

/**
 * Validate explicit selection against the Session policy and merge it over child
 * defaults, or resolve an omitted selection inside a recorded policy. Explicit
 * selection requires both provider and model; an omitted effort then uses the
 * selected model's default, even when the route is unchanged. An omitted
 * selection with a recorded policy resolves deterministically to the
 * configured route, then the parent route, otherwise the policy's first route.
 * @param configured - Tool-instance child defaults.
 * @param request - Model-facing route override.
 * @param enabled - Whether this tool instance permits model-facing selection.
 * @param policy - Session allowlist; omission leaves the configured options unchanged.
 * @param parentOptions - Current parent route used when no policy is recorded and as an omitted-selection fallback.
 * @returns Child Agent options, preserving omission when no layer contributes one.
 */
export function requestedAgentOptions(
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
): AgentOptions | undefined {
  if (!hasDelegationModelRequest(request)) {
    if (policy === undefined) return configured
    return withSelectedRoute(configured, firstAllowedRoute(policy, [configured, parentOptions]))
  }
  if (!enabled) {
    throw new Error('child model selection is disabled for this tool instance')
  }
  assertNonEmpty(request.provider, 'provider')
  assertNonEmpty(request.model, 'model')
  assertNonEmpty(request.reasoning_effort, 'reasoning_effort')
  if (request.provider === undefined || request.model === undefined) {
    throw new Error(request.reasoning_effort === undefined
      ? 'child LLM `provider` and `model` must be supplied together'
      : 'child LLM `reasoning_effort` requires both `provider` and `model`; supply both or omit all three fields')
  }

  assertAllowedModelSelection(policy, parentOptions, { provider: request.provider, model: request.model })
  return {
    ...configured,
    provider: request.provider,
    model: request.model,
    // Explicit undefined also clears compatible parent effort during child-option merging.
    reasoningEffort: request.reasoning_effort === undefined ? undefined : ReasoningEffortId(request.reasoning_effort),
  }
}

/**
 * Whether configured Agent options require route validation before delegation.
 * @param options - Tool-instance child defaults.
 * @returns Whether configured provider, model, or effort values must be resolved.
 */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * Resolve an effective child route through its live adapter before the child is
 * created. The LLM runtime owns provider lookup, exact-model metadata, effort
 * validation, and adapter defaults.
 * @param llm - Live LLM runtime.
 * @param parentOptions - Current parent values whose compatible fields the child inherits.
 * @param requested - Per-child options after request/config merging.
 * @param signal - Tool-call cancellation signal.
 * @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route; false for explicit model selection.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : undefined)
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}
