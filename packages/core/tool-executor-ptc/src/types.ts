/**
 * Client-safe PTC dispatch events and message-source declarations.
 *
 * The nested-dispatch payload types are owned by the client-safe
 * `@deepseek-ai/dsh-tools/types` entry, shared by every composite tool, and
 * exported here under the PTC names consumers already use.
 *
 * @module @deepseek-ai/dsh-tool-executor-ptc/types
 */

export type {
  SubDispatchStartEventData as PtcDispatchStartEventData,
  SubDispatchEventData as PtcDispatchEventData,
} from '@deepseek-ai/dsh-tools/types'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** PTC context, including deferred subcall images and host environment-reset notices. */
    'ptc-mode': { kind: 'ptc-mode' }
  }
}
