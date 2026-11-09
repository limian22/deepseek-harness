/** Operator-facing replies posted by the dsh-superagent orchestration, rendered as the bot's own message. */
import { memo, useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextMessageNode } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import css from './OperatorReplyView.module.css'

/**
 * Whether a logged message source marks a reply the orchestration posted for
 * the operator (an acknowledgement or an answer) rather than an internal
 * relay. Such a message must stay readable as the bot's own reply, so it is
 * not presented as a folded context injection.
 * @param source - logged `user/message` source.
 * @returns whether the source is an operator-facing reply.
 */
export function isOperatorReply(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as { kind?: unknown; reply?: unknown }
  return record.kind === 'dsh-superagent' && record.reply === true
}

/**
 * Join the text blocks of a logged message into one Markdown body.
 * @param content - logged message content blocks.
 * @returns the reply text, one trimmed block per line.
 */
export function replyText(content: ContextMessageNode['content']): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text.trim()] : [])).filter(Boolean).join('\n')
}

/** Operator-facing reply row: the same narration column as an Assistant answer. */
export const OperatorReplyView = memo(function OperatorReplyView({ content, t }: {
  content: ContextMessageNode['content']
  t: ChatViewSlotProps['t']
}) {
  // Stable per locale revision: a fresh object per render would rebuild MarkdownText's table.
  const labels = useMemo(() => markdownLabels(t), [t])
  const text = replyText(content)
  if (text === '') return null
  return (
    <div className={css.root} data-operator-reply>
      <MarkdownText text={text} streaming={false} labels={labels} />
    </div>
  )
})
