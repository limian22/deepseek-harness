// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import type { ContextMessageNode } from '../src/client/contract/snapshot.ts'
import { isOperatorReply, OperatorReplyView, replyText } from '../src/client/chat/OperatorReplyView.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)

const text = 'Syncthing 同步目录已核实：C:\\Users\\qq135\\AppData\\Local\\Programs\\Syncthing\\Leegenux_mind'

function content(textValue: string): ContextMessageNode['content'] {
  return [{ type: 'text', text: textValue }]
}

describe('operator reply rendering', () => {
  it('recognizes only a marked dsh-superagent reply source', () => {
    expect(isOperatorReply({ kind: 'dsh-superagent', form: 'relay', reply: true })).toBe(true)
    expect(isOperatorReply({ kind: 'dsh-superagent', form: 'relay' })).toBe(false)
    expect(isOperatorReply({ kind: 'dsh-superagent', form: 'notice', summary: 'x' })).toBe(false)
    expect(isOperatorReply({ kind: 'user' })).toBe(false)
    expect(isOperatorReply(null)).toBe(false)
    expect(isOperatorReply('dsh-superagent')).toBe(false)
  })

  it('joins text blocks into one trimmed Markdown body', () => {
    expect(replyText([{ type: 'text', text: ' a ' }, { type: 'text', text: 'b ' }])).toBe('a\nb')
    expect(replyText([])).toBe('')
  })

  it('renders the reply as visible message text, not a folded context row', () => {
    const view = render(<OperatorReplyView content={content(text)} t={t} />)
    expect(view.container.querySelector('[data-operator-reply]')).not.toBeNull()
    expect(view.getByText(/Syncthing 同步目录已核实/)).toBeTruthy()
    // The context-injection disclosure chrome must not wrap a marked reply.
    expect(view.container.querySelector('[data-context-source]')).toBeNull()
    expect(view.container.querySelector('[data-context-injection-body]')).toBeNull()
  })
})
