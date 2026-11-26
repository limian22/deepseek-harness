/** Provide an earlier live Session with a stable event timestamp. */
import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const inject = ['sessions', 'agentLoop', 'systemPrompt']

export function apply(ctx: Context): void {
  const cwd = process.cwd()
  if (sep === '\\') {
    // Use a slash spelling so the normalizer can recognize the Windows cwd in request text.
    ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
      if (turn === 1 && step === 1) {
        agent.ctx.systemPrompt.context({
          name: 'working-directory:current',
          order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
          required: true,
          interpolate: false,
          text: `Current working directory: ${JSON.stringify(cwd.split(sep).join('/'))}.`,
        })
      }
      return next()
    })
  }

  ctx.sessions.create(SessionId('han-search-example'), {
    meta: { cwd, createdAt: 1_000 },
    seed: [{
      type: 'user/message',
      seq: SessionSeq(0),
      time: 1_000,
      data: createUserMessage({
        content: [{ type: 'text', text: '前缀中文检索后缀' }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    }],
  })
}
