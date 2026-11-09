/**
 * Durable records for one nested tool dispatch inside a composite tool: a
 * `run_code` program sub-call or an on-demand MCP tool call.
 *
 * The event keys and payload fields are the established nested-dispatch
 * vocabulary. Replay, UIs, and SDKs therefore treat every nested call the same
 * way regardless of which composite produced it; a composite records the
 * start before the pipeline stages run and the settlement before its own
 * result returns, so the enclosing call durably contains the inner one.
 *
 * Sub-call ids are opaque conventions: `<parent>:ptc:<n>` for program
 * sub-calls, `<parent>:mcp:<n>` for on-demand MCP calls.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolErrorInfo, ToolExecution } from './contracts.ts'
import type { ToolsService } from './index.ts'
import { toolErrorMessage } from './pipeline.ts'
import type { SubDispatchStartEventData } from './types.ts'

/**
 * One settled nested dispatch about to be logged, as seen by the
 * `tools/ptc-dispatch-log` waterfall: the parent execution (session owner,
 * outer call identity), the sub-call identity, and the outcome whose durable
 * copy a listener may reshape. Only the `tool/ptc-dispatch` event's copy
 * changes; the nested call's own result is unaffected.
 */
export interface SubDispatchLog {
  /** The enclosing composite execution. */
  readonly exec: ToolExecution
  /** The calling agent (the scope routing key and the spill owner), when the outer call has one. */
  readonly agent?: Agent
  /** Opaque nested-call identity; see the module conventions. */
  readonly subCallId: ToolCallId
  /** The dispatched original tool name. */
  readonly name: string
  /** Whether the nested call settled as a failure. */
  readonly isError: boolean
  /** The nested call's authoritative final model-facing content. */
  readonly content: ContentBlock[]
}

/** Everything one settlement record needs beyond the authoring composite. */
export interface SubDispatchSettlement {
  /** The enclosing composite execution. */
  readonly exec: ToolExecution
  /** Opaque nested-call identity paired with the start record. */
  readonly subCallId: ToolCallId
  /** The dispatched original tool name. */
  readonly name: string
  /** Whether the nested call settled as a failure. */
  readonly isError: boolean
  /** The authoritative post-policy content to record. */
  readonly content: ContentBlock[]
  /** The exact dispatched arguments, JSON-normalized before dispatch. */
  readonly arguments: unknown
  /** Replayable tool-owned presentation metadata, separate from model content. */
  readonly meta?: JsonValue
  /** Structured failure identity and raw user-facing detail, outside model-facing content. */
  readonly error?: ToolErrorInfo
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Allow a listener to replace content in the DURABLE LOG COPY of one nested
     * dispatch outcome before the bridge appends its `tool/ptc-dispatch` event.
     * `next()` keeps the content unchanged; a listener may return replacement
     * blocks (e.g. the spill policy's preview + locator for an oversized text
     * result). Only the logged copy is affected — the nested call's own result
     * and its model-visible content are untouched. A throwing listener is
     * contained: the bridge falls back to logging the original settled content.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.
     * @param dispatch - the parent execution, sub-call identity, and the settled content to log.
     * @mode waterfall
     */
    'tools/ptc-dispatch-log'(this: Scoped<ToolsService>, dispatch: SubDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
  }
}

/**
 * Append the start record for one nested dispatch before its pipeline stages run.
 * @param agent - session owner; omitted when the enclosing call has no Agent.
 * @param data - parent/root identity, sub-call identity, original name, and dispatched arguments.
 */
export function appendSubDispatchStart(agent: Agent | undefined, data: SubDispatchStartEventData): void {
  agent?.session.append('tool/ptc-dispatch-start', data)
}

/**
 * Shape and append the settlement record for one nested dispatch. A failing
 * log listener is contained; the original settled content is recorded.
 * @param ctx - context owning the waterfall and logger; its own properties stay usable while inactive.
 * @param tools - retained registry, captured before the owning context can become inactive.
 * @param agent - session owner; omitted when the enclosing call has no Agent, so nothing is recorded.
 * @param settlement - enclosing execution, sub-call identity, original name, authoritative content, and optional metadata.
 * @returns completion after the durable settlement record is appended.
 */
export async function appendSubDispatch(
  ctx: Context,
  tools: ToolsService,
  agent: Agent | undefined,
  settlement: SubDispatchSettlement,
): Promise<void> {
  if (agent === undefined) return
  const content = await shapeSubDispatchContent(ctx, tools, {
    exec: settlement.exec,
    agent,
    subCallId: settlement.subCallId,
    name: settlement.name,
    isError: settlement.isError,
    content: settlement.content,
  })
  agent.session.append('tool/ptc-dispatch', {
    rootCallId: settlement.exec.rootCallId,
    parentCallId: settlement.exec.callId,
    subCallId: settlement.subCallId,
    name: settlement.name,
    arguments: settlement.arguments,
    isError: settlement.isError,
    ...settlement.error === undefined ? {} : { error: settlement.error },
    content,
    ...settlement.meta === undefined ? {} : { meta: settlement.meta },
  })
}

/** Run the durable-log waterfall for one settled nested dispatch, containing listener failures. */
async function shapeSubDispatchContent(ctx: Context, tools: ToolsService, dispatch: SubDispatchLog): Promise<ContentBlock[]> {
  try {
    return await ctx.waterfall(
      scopeTarget(tools, dispatch.agent), 'tools/ptc-dispatch-log', dispatch,
      () => Promise.resolve(dispatch.content),
    )
  } catch (error: unknown) {
    ctx.logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${toolErrorMessage(error)}; logging the original settled content`)
    return dispatch.content
  }
}
