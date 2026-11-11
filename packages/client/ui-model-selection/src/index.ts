/**
 * Model selection plugin, node half. The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration; this half only owns the user's pinned-model list so favorites
 * persist on the Host (profile-backed) rather than in one browser's storage.
 *
 * The pinned list is a single volatile settings field. The browser reads it
 * through the shared configuration forms and writes it back through
 * `settings.mutate`; the generated settings page is suppressed because the
 * only editor is the model picker's star control.
 */
import type {} from '@deepseek-ai/dsh-settings'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelFavorite } from './types.ts'

export type { ModelFavorite } from './types.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Pinned models, in the order the user added them. */
  favorites: Volatile<ModelFavorite[]>
}

/** Live pinned-model preference. */
export const Config = z.object({
  favorites: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })).default([]).volatile(),
})

/** Host plugin body: own the settings presentation policy (no generated page). */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
