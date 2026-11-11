/**
 * Model selection plugin, browser half — TWO entries over ONE per-session
 * directory owned by ModelDirectoryResolver (`ctx.modelDirectories`). The /model popupSelect
 * contribution and the composer's named `conversation.input.model` seat share
 * one Host-generation `session/modelCatalog` catalog, combine it with the Session's
 * durable model-selection projection, and submit through `session.selectModel`.
 * A switch made in either entry is what the other shows next. Failures
 * ride each entry's own retry surface (popup shell error/retry; seat menu
 * inline error) without forking the state. Addressed subagent sessions expose
 * neither entry because those Agent-bound RPCs would activate persisted
 * history outside the direct-parent continuation path.
 */
// Type-only: the carrier types, the forwarded Host-event face and the ctx.remote merge.
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CommandUiContract, SelectOption, SelectOptionAction } from '@deepseek-ai/dsh-client-ui-commands/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.model seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectoryState } from './directory.ts'
import { ModelDirectoryResolver } from './service.ts'
import { FAVORITES_GROUP_ID, ModelFavorites, favoriteKey } from './favorites.ts'
import type { ModelSelectInjected } from './slots.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type ModelKey } from './locales.ts'
import { orderModelProviders } from './provider-order.ts'

export { ModelDirectory } from './directory.ts'
export type { ModelDirectoryState } from './directory.ts'
export { ModelDirectoryResolver } from './service.ts'
export { ModelFavorites, favoriteKey, MODEL_FAVORITES_NS } from './favorites.ts'
export type { ModelFavoritesState, ModelFavoritesSection } from './favorites.ts'
export type { ModelFavorite } from '../types.ts'
export type { ModelLabelOwner, ModelSelectInjected, ModelFavoritesFace } from './slots.ts'
export type { ModelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The model selection surfaces' copy (/model popup + composer seat). */
    model: ModelKey
  }
}

/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** Provider heading text, localizing the DeepSeek account group. */
function providerLabel(group: ModelProviderGroup, t: TranslateNS<'model'>): string {
  return group.id === 'deepseek-account' ? t('provider.account') : group.name
}

/** The star action attached to one model row: toggles its pinned entry in place. */
function favoriteAction(
  group: ModelProviderGroup, model: ModelCatalogModel, favorited: boolean,
  t: TranslateNS<'model'>, favorites: ModelFavorites,
): SelectOptionAction {
  return {
    label: t(favorited ? 'favorites.remove' : 'favorites.add', { model: model.name }),
    pressed: favorited,
    invoke: () => favorites.toggle(group.id, model.id).then(() => { /* reload carries the result */ }),
  }
}

/**
 * Flatten the directory into popup rows; failure rows are listed for visibility
 * but never selectable. When the Host serves a favorites namespace, pinned
 * models form a top group (in pin order) and are omitted from their provider
 * groups, and every model row carries a star action. Without the namespace the
 * rows are unchanged.
 */
function optionsOf(directory: ModelDirectoryState, t: TranslateNS<'model'>, favorites: ModelFavorites): SelectOption[] {
  const rows: SelectOption[] = []
  const favoriteState = favorites.getSnapshot()
  const favoritesEnabled = favoriteState.status === 'ready'
  const favoritePairs = favoritesEnabled ? favoriteState.favorites : []
  const favoriteKeys = new Set(favoritePairs.map(fav => favoriteKey(fav.provider, fav.model)))
  const ordered = orderModelProviders(directory.groups)
  const byKey = new Map<string, { group: ModelProviderGroup; model: ModelCatalogModel }>()
  for (const group of ordered) {
    for (const model of group.models) byKey.set(rowId(group.id, model.id), { group, model })
  }
  const activeOf = (provider: string, model: string): { active?: true } =>
    directory.current !== null && directory.current.provider === provider && directory.current.model === model
      ? { active: true } : {}
  if (favoritePairs.length > 0) {
    const groupName = FAVORITES_GROUP_ID
    for (const fav of favoritePairs) {
      const found = byKey.get(rowId(fav.provider, fav.model))
      if (found === undefined) continue
      rows.push({
        id: rowId(found.group.id, found.model.id),
        label: found.model.name,
        group: { name: groupName, label: t('favorites.group') },
        ...activeOf(found.group.id, found.model.id),
        ...favoritesEnabled ? { action: favoriteAction(found.group, found.model, true, t, favorites) } : {},
      })
    }
  }
  for (const group of ordered) {
    const name = providerLabel(group, t)
    for (const model of group.models) {
      if (favoriteKeys.has(rowId(group.id, model.id))) continue
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        group: { name: group.id, label: name },
        ...activeOf(group.id, model.id),
        ...favoritesEnabled ? { action: favoriteAction(group, model, false, t, favorites) } : {},
      })
    }
  }
  for (const failure of directory.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.id === 'deepseek-account' ? t('provider.account') : failure.name,
      detail: t('option.loadError', { message: failure.message }),
    })
  }
  return rows
}

/**
 * Resolve a picked row back to its model selection by matching against the loaded
 * groups (the same data the rows were built from — ids stay opaque).
 * @param state - the session's directory snapshot.
 * @param id - the picked row id.
 * @returns the row's model selection, or undefined for failure rows / stale ids.
 */
function selectionOf(state: ModelDirectoryState, id: string): ModelSelection | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue
      const sameRoute = state.current?.provider === group.id && state.current.model === model.id
      const reasoningEffort = sameRoute
        ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort
      return {
        provider: group.id,
        model: model.id,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
    }
  }
  return undefined
}

/** Dictionary namespace owned by this plugin. */
const NS = 'model'

/** Required services: the contribution registry, the seat's slot registry, locale, settings forms, and the service's own faces. */
export const inject = ['commandUi', 'locale', 'sessions', 'slots', 'remote', 'remote.session', 'configForms']

/**
 * Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
 * then register the /model popup contribution and the composer model seat
 * over the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-model-selection: dictionaries')

  // Non-slot faces (the command description, the popup option builder) read
  // through the bound translate; the seat component reads the standard seat.
  const t = ctx.locale.bind(NS)

  // One Host-persisted pinned list shared by both entries; disposed with the plugin.
  const favorites = new ModelFavorites(ctx)
  ctx.effect(() => () => favorites.dispose(), 'ui-model-selection: favorites')

  ctx.plugin(ModelDirectoryResolver)

  // Entry 1: the /model popupSelect over the shared directory.
  ctx.inject(['commandUi', 'modelDirectories'], (scope: ClientContext) => {
    const command = scope.get('commandUi') as CommandUiContract
    const models = scope.modelDirectories
    const sessions = scope.sessions
    scope.effect(() => command.register({
      name: 'model',
      label: () => t('command.label'),
      description: () => t('command.description'),
      icon: IconDataOutlineRegular,
      available: session => sessions.subagentAddress(session.sessionId) === undefined,
      ui: {
        kind: 'popupSelect',
        searchLabels: () => ({
          placeholder: t('search.placeholder'),
          empty: t('empty.models'),
          noResults: t('search.empty'),
        }),
        options: async (session) => {
          if (sessions.subagentAddress(session.sessionId) !== undefined) {
            throw new Error('model selection is unavailable for addressed subagent sessions')
          }
          return optionsOf(await models.directoryFor(session.sessionId).load(), t, favorites)
        },
        onSelect: async (option, session) => {
          if (sessions.subagentAddress(session.sessionId) !== undefined) {
            throw new Error('model selection is unavailable for addressed subagent sessions')
          }
          const directory = models.directoryFor(session.sessionId)
          const selection = selectionOf(directory.store.getSnapshot(), option.id)
          if (selection === undefined) {
            throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group')
          }
          const result = await directory.select(selection)
          if (!result.ok) {
            if (result.error.code === 'session/writer-held') throw new Error(t('error.sessionInUse'))
            throw result.error
          }
        },
      },
    }), 'ui-model-selection: /model contribution')
  })

  // Entry 2: the composer's named model seat over the SAME directory.
  ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      locale: NS,
      children: {
        'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
        'conversation.input.model.options': { kind: 'list', scope: 'session' },
        'conversation.input.model.pane': { kind: 'keyed', scope: 'session' },
      },
      inject: (sessionId): ModelSelectInjected => {
        const directory = models.directoryFor(sessionId)
        const available = sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => { /* surfaced on the store */ })
          },
          favorites,
          resolveText: text => ctx.locale.resolveText(text),
          select: (selection: ModelSelection) => available
            ? directory.select(selection)
            : Promise.resolve(undefined),
        }
      },
    }, ModelSelect))
  })
}
