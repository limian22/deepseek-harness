// @vitest-environment jsdom
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** A renderer may consume a published entry before the rest of apply has run. */
describe('Conversation composer publication order', () => {
  it('makes the conversation service available when publishing the composer bar', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const sid = 'console-startup-order' as SessionId
      await runtime.sessions.add({ id: sid })
      const reference = runtime.sessions.retain(sid)
      await reference.ready
      runtime.ctx.provide('uiWorkspace', { openWorkspace: vi.fn(), openSession: vi.fn() } as never)
      runtime.ctx.provide('configForms', {
        developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope,
      } as never)
      const locale = new LocaleRuntime(runtime.ctx)
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
      await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
      await runtime.root.declare({
        main: { kind: 'keyed', scope: 'root' },
        'settings.general.item': { kind: 'list', scope: 'root' },
      }, () => null)
      runtime.renderRoot()
      const register = runtime.slots.register.bind(runtime.slots)
      const failures: string[] = []
      let observed = 0
      vi.spyOn(runtime.slots, 'register').mockImplementation((...args: Parameters<typeof register>) => {
        const result = register(...args)
        if (args[0].name === 'conversation.composer.bar') {
          observed++
          try {
            const entry = runtime.slots.entries('conversation.composer.bar')[0]!
            const create = entry.inject as (id: SessionId) => unknown
            create(sid)
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error))
          }
        }
        return result
      })
      await runtime.mount({ inject: [...inject], apply })
      expect(observed).toBe(1)
      expect(failures).toEqual([])
      reference.release()
    } finally {
      await runtime.dispose()
      vi.restoreAllMocks()
    }
  })
})
