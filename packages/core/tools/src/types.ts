/**
 * Client-safe payloads for the nested-dispatch session events shared by every
 * composite tool (a `run_code` program sub-call or an on-demand MCP tool
 * call). No host runtime is imported here, so Client programs can read the
 * event types without pulling the tool registry, Agent, or service graph into
 * their declaration graph.
 *
 * @module @deepseek-ai/dsh-tools/types
 */

import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Payload recorded when one nested tool dispatch starts. */
export interface SubDispatchStartEventData {
  /** Root model-requested call owning the whole execution tree. */
  rootCallId: ToolCallId
  /** The enclosing composite call that dispatched this nested call. */
  parentCallId: ToolCallId
  /** Opaque nested-call identity paired with the settlement record. */
  subCallId: ToolCallId
  /** The original registered tool name that was dispatched. */
  name: string
  /** The exact dispatched arguments, JSON-normalized before dispatch. */
  arguments: unknown
}

/** Payload recorded when one nested tool dispatch settles. */
export interface SubDispatchEventData extends SubDispatchStartEventData {
  /** Whether the nested call settled as a failure (denial, abort, or tool error). */
  isError: boolean
  /** The nested call's authoritative final model-facing content. */
  content: ContentBlock[]
  /** Replayable tool-owned presentation metadata, separate from model content. */
  meta?: JsonValue
  /** Structured failure identity and raw user-facing detail, outside model-facing content. */
  error?: { name: string; code: string; reason?: string }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One nested tool dispatch STARTING inside a composite call: the enclosing
     * call id, the opaque sub-call id (new calls use `<parent>:ptc:<n>` for a
     * program sub-call or `<parent>:mcp:<n>` for an on-demand MCP call), and the
     * original tool `name` with its JSON-normalized `arguments` — the exact
     * value dispatched, normalized BEFORE dispatch, so this append can never
     * fail on payload shape. Appended before the pipeline stages run, so a
     * start means the guarded invocation pipeline was entered; the producing
     * bridge appends the settlement with the same `subCallId` when the call
     * settles (that append itself can still fail).
     * Log-only: `deriveMessages()` ignores it; UIs use it for live per-sub-call
     * running state and pair it with `tool/ptc-dispatch` by `subCallId`.
     */
    'tool/ptc-dispatch-start': SubDispatchStartEventData
    /**
     * One nested tool dispatch SETTLING: the pairing ids (matching the
     * `tool/ptc-dispatch-start` with the same `subCallId`), the original tool
     * `name` with the same JSON-normalized `arguments`, and the sub-call's
     * complete durable outcome in `tool/result`'s own vocabulary (`content` +
     * `isError` + optional presentation `meta` and structured `error`), so UIs
     * and SDKs render a sub-call through the exact path used for a native call.
     * Every started sub-call settles with exactly one of these (abort included:
     * the aborted pipeline result is an `isError` outcome).
     * Log-only: `deriveMessages()` ignores it, so sub-calls never re-enter model
     * context; persistence and UIs get every call. Appended inside the
     * enclosing composite's execution (which drains in-flight dispatches before
     * returning), so its execution-enclosure relation holds by construction.
     */
    'tool/ptc-dispatch': SubDispatchEventData
  }
}
