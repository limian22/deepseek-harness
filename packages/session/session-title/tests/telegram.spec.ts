import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, type SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionTitleService, { SessionTitleProviderId, type SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 })
  return { ctx, session: ctx.sessions.create(brandString<SessionId>('telegram-title')) }
}

function prompt(session: ReturnType<Context['sessions']['create']>) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Original prompt' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

describe('Telegram topic titles', () => {
  it('normalizes, projects, and deduplicates a Telegram title', async () => {
    const { ctx, session } = await harness()
    const accepted = ctx.sessionTitle.syncTelegramTopicTitle(session, '  Topic   name ')
    expect(accepted).toMatchObject({ title: 'Topic name', source: { kind: 'user', origin: 'telegram' }, messageSeqs: [] })
    expect(ctx.sessionProjections.snapshot(session).values.title).toBe('Topic name')
    expect(ctx.sessionTitle.syncTelegramTopicTitle(session, 'Topic name')).toEqual(accepted)
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })

  it('preserves explicit user titles and ignores empty topic titles', async () => {
    const { ctx, session } = await harness()
    expect(ctx.sessionTitle.syncTelegramTopicTitle(session, '   ')).toBeUndefined()
    const manual = ctx.sessionTitle.rename(session, 'Manual')
    expect(ctx.sessionTitle.syncTelegramTopicTitle(session, 'Telegram')).toEqual(manual)
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })

  it('rejects sessions outside the active store', async () => {
    const { ctx } = await harness()
    const session = Session.create(brandString<SessionId>('detached'))
    expect(() => ctx.sessionTitle.syncTelegramTopicTitle(session, 'Topic')).toThrow(/not live in this store/)
  })

  it('supersedes an active provider and blocks later automatic generations', async () => {
    const { ctx, session } = await harness()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    let signal!: AbortSignal
    const generate = vi.fn(async (request: SessionTitleProviderRequest) => {
      signal = request.signal
      started()
      await gate
      return { title: 'Late provider', messageSeqs: request.messages.map(message => message.seq) }
    })
    ctx.sessionTitle.register({ id: SessionTitleProviderId('telegram-test'), automatic: 'all-prompts', generate })
    session.append('turn/start', { turn: 1 })
    prompt(session)
    session.append('request/header', { header: { config: { provider: 'main', model: 'model' } }, reason: 'initial' })
    await startedPromise
    ctx.sessionTitle.syncTelegramTopicTitle(session, 'Topic')
    expect(signal.aborted).toBe(true)
    release()
    await vi.waitFor(() => { expect(ctx.sessionTitle.get(session)?.title).toBe('Topic') })
    prompt(session)
    session.append('request/header', { header: { config: { provider: 'main', model: 'model' } }, reason: 'change' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(generate).toHaveBeenCalledOnce()
    expect(ctx.sessionTitle.get(session)?.source).toEqual({ kind: 'user', origin: 'telegram' })
  })

  it('allows explicit refresh to unpin the Telegram title', async () => {
    const { ctx, session } = await harness()
    prompt(session)
    ctx.sessionTitle.syncTelegramTopicTitle(session, 'Topic')
    expect(await ctx.sessionTitle.refresh(session)).toMatchObject({ title: 'Original prompt', source: { kind: 'fallback' } })
  })
})
