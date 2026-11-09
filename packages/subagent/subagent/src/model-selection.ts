/**
 * Durable per-Session child LLM authorization and its deterministic implicit route.
 * The subagent seam owns this state so every delegation entry — the model-facing
 * tools, workflow scripts, and external backends that accept Agent options —
 * resolves child routes through one rule.
 * @module @deepseek-ai/dsh-subagent/model-selection
 */

import { z as zod } from 'zod'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/** Exact routes authorized for one Session. */
export interface ModelSelectionPolicy {
  /** Exact provider/model routes authorized for child LLM selection. */
  readonly routes: readonly AllowedModelRoute[]
}

/**
 * Stable identity for one provider/model pair.
 * @param route - Exact provider/model route.
 * @returns Opaque key for equality checks.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Reject malformed or duplicate route policy entries at a durable or configuration boundary.
 * @param routes - Candidate exact routes to validate.
 * @returns an assertion that the candidate is a validated exact-route array.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
  }
}

/**
 * Enforce Session authorization for a complete, explicitly selected child route.
 * @param policy - Session allowlist; omission keeps the existing parent-route-only rule.
 * @param parentOptions - Current parent route used when no policy is recorded.
 * @param route - Validated provider/model pair from the caller.
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: Pick<AgentOptions, 'provider' | 'model'>,
  route: AllowedModelRoute,
): void {
  const { provider, model } = route
  const allowed = policy === undefined
    ? provider === parentOptions.provider && model === parentOptions.model
    : policy.routes.some(route => route.provider === provider && route.model === model)
  if (allowed) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`
    + (policy === undefined
      ? '; without a recorded model-selection policy, explicit selection is limited to the parent route'
      : ''))
}

/**
 * Resolve the deterministic route for an omitted selection: the first complete
 * candidate the policy lists, otherwise the policy's first route. Callers order
 * candidates by preference (configured route, then the parent route).
 * @param policy - Session allowlist, which the projection guarantees non-empty.
 * @param candidates - Complete or partial route suggestions in preference order.
 * @returns The authorized provider/model pair.
 * @throws When the policy lists no routes and no candidate is authorized.
 */
export function firstAllowedRoute(
  policy: ModelSelectionPolicy,
  candidates: readonly (Pick<AgentOptions, 'provider' | 'model'> | undefined)[],
): AllowedModelRoute {
  for (const candidate of candidates) {
    const provider = candidate?.provider
    const model = candidate?.model
    if (provider === undefined || model === undefined) continue
    if (policy.routes.some(route => route.provider === provider && route.model === model)) {
      return { provider, model }
    }
  }
  const [first] = policy.routes
  if (first === undefined) {
    throw new Error('subagent model selection policy allows no routes')
  }
  return { ...first }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records this Session's authorized child provider/model routes. Appended
     * before the first model request; absence keeps the existing parent-route
     * fallback. When present, both explicit selection and an omitted route
     * must resolve inside this list. Log-only: it carries no `surfaceOp` and
     * never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session authorizes for child LLM selection, explicit or implicit. */
      allowedModels: AllowedModelRoute[]
    }
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).min(1).nullable()

/**
 * Host-only projection of the durable model-selection policy.
 * Each independently mounted consumer registers this shared definition; the registry reference-counts it.
 */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    return allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * Read the exact route list authorized for a Session.
 * @param handle - registered policy state reader.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined when the Session records no policy.
 */
export function subagentModelSelectionPolicy(
  handle: Pick<ProjectionHandle<AllowedModelRoute[] | null>, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return handle.stateOf(session)?.map(route => ({ ...route }))
}
