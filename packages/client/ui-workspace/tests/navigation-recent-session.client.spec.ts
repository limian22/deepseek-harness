/** A→B→A against the real Client Session service, counting opening follow streams. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientSessions } from '../../../api/session-controller/src/client/sessions/service.ts'
import type { SessionRemotes } from '../../../api/session-controller/src/client/sessions/remotes.ts'
import { FOLLOW, sessionWorld } from '../../../api/session-controller/tests/remote/session.client.ts'
import { UiWorkspaceService } from '../src/client/navigation.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (id: string): SessionId => SessionId(id)
const A = sid('real-warm-a')
const B = sid('real-warm-b')
const pendingWorkspaces: WorkspaceSnapshot = {
  items: [],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  phase: 'pending',
  state: 'loading',
  error: null,
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function summary(sessionId: SessionId) {
  return { agentAvailable: true, sessionId, updatedAt: 1, running: false, blank: false, cwd: '/w' }
}

describe('recent Session warm cache against ClientSessions', () => {
  it('keeps one follow for A across A→B→A and preserves A\'s binding', async () => {
    const mock = RemoteMock.create().load(sessionWorld)
    mock.remote.session.list.mockResolvedValue(ok({
      items: [summary(A), summary(B)],
    }))
    const followOpens: string[] = []
    const remote = {
      ...mock.remote,
      $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream<Item>(
        { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
        {
          ...options,
          open: (signal) => {
            followOpens.push(options.name)
            return options.open(signal)
          },
        },
      ),
    } as unknown as SessionRemotes

    const ctx = new Context()
    contexts.push(ctx)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('en')
    ctx.effect(() => locale.register('workspace', { en, zh }))
    ctx.provide('locale', locale)
    const layout = new LayoutController({
      selectPanel: () => {},
      retainMainPanels: () => {},
      setSidebar: () => {},
      toggleSidebar: () => {},
      setViewportWidth: () => {},
      setRightbar: () => {},
      openRightbar: () => {},
      closeRightbar: () => {},
    }, () => true, createSnapshotStore({ activePanelId: null }))
    ctx.provide('layout', layout)
    ctx.effect(() => () => { layout.dispose() })

    const workspacesList = createSnapshotStore<WorkspaceSnapshot>(pendingWorkspaces)
    const workspaces = {
      list: workspacesList,
      initializeDefault: async () => undefined,
      archiveSession: async () => {},
      unarchiveSession: async () => {},
      pinSession: async () => {},
      unpinSession: async () => {},
    } as unknown as IWorkspaces
    const view = createWorkspaceViewStore().create()
    const sessions = new ClientSessions(ctx, remote)
    const sessionStatus = createSnapshotStore(new Map())
    ctx.provide('uiSession', { sessionStatus } as never)
    const uiWorkspace = new UiWorkspaceService(
      ctx,
      {} as ClientRemote['directoryPicker'],
      workspaces,
      sessions,
      view.actions,
      () => {},
      createSnapshotStore<number | undefined>(10),
    )

    await sessions.refresh()

    uiWorkspace.openSession(A)
    await mock.streams.opened(FOLLOW, 1)
    const bindingA = sessions.binding(A)
    expect(bindingA).toBeDefined()
    expect(followOpens).toEqual(['session event stream'])
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)

    uiWorkspace.openSession(B)
    await mock.streams.opened(FOLLOW, 2)
    expect(followOpens).toHaveLength(2)
    expect(mock.log.requests(FOLLOW)).toHaveLength(2)
    expect(sessions.binding(A) === bindingA).toBe(true)

    uiWorkspace.openSession(A)
    await Promise.resolve()
    await Promise.resolve()
    expect(sessions.binding(A) === bindingA).toBe(true)
    expect(followOpens).toHaveLength(2)
    expect(mock.log.requests(FOLLOW)).toHaveLength(2)

    await ctx.fiber.dispose()
    expect(mock.log.streams(FOLLOW).filter(stream => stream.state === 'open')).toHaveLength(0)
  })
})
