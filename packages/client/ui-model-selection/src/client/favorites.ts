/**
 * Host-persisted pinned-model list shared by both model-selection entries.
 *
 * One configuration-form namespace (`ui-model-selection`, owned by this
 * plugin's host half) carries an ordered array of provider/model pairs. This
 * controller folds that settings form into a small snapshot store both the
 * composer seat and the `/model` popup render from, and serializes star
 * toggles into atomic whole-array writes so rapid clicks cannot clobber each
 * other.
 *
 * Toggles are OPTIMISTIC: the store reflects the new membership immediately
 * (so the star and the pinned group update on click), while the Host write
 * settles behind it. A rejected/thrown write reverts to the last server-known
 * list. When the Host serves no such namespace the state stays `unavailable`
 * and both entries simply hide the star affordance.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.configForms and the ConfigForm face into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelFavorite } from '../types.ts'

/** The settings namespace this plugin owns (its Host loader entry id). */
export const MODEL_FAVORITES_NS = 'ui-model-selection'

/** Stable id for the synthetic "favorites" group both surfaces render. */
export const FAVORITES_GROUP_ID = '__model-favorites__'

/** The namespace section this plugin reads and writes. */
export interface ModelFavoritesSection {
  /** Ordered pinned provider/model pairs. */
  favorites: ModelFavorite[]
}

/** Render state both entries subscribe to. */
export interface ModelFavoritesState {
  /** `loading` until the first accepted section; `unavailable` when the Host serves none. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Ordered pinned pairs (empty until the first accepted section). */
  favorites: readonly ModelFavorite[]
}

/** Process-wide identity for one provider/model pair. */
export function favoriteKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Set-equality over pinned pairs (order-insensitive). */
function sameFavorites(left: readonly ModelFavorite[], right: readonly ModelFavorite[]): boolean {
  if (left.length !== right.length) return false
  const keys = new Set(left.map(fav => favoriteKey(fav.provider, fav.model)))
  return right.every(fav => keys.has(favoriteKey(fav.provider, fav.model)))
}

const INITIAL: ModelFavoritesState = { status: 'loading', favorites: [] }

/** Fold the settings form into a render store and serialize toggles. */
export class ModelFavorites {
  /** Render snapshot both entries subscribe to. */
  readonly store: SnapshotStore<ModelFavoritesState> = createSnapshotStore<ModelFavoritesState>(INITIAL)

  private readonly form: ConfigForm<ModelFavoritesSection>
  private readonly unsubscribe: () => void
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  /** Optimistic membership shown ahead of the Host; null when reconciled to the form. */
  private optimistic: ModelFavorite[] | null = null
  /** Writes still crossing the wire; the optimistic overlay survives until the last settles. */
  private pending = 0

  /**
   * @param ctx - the browser plugin context whose `configForms` carries the namespace.
   */
  constructor(ctx: ClientContext) {
    this.form = ctx.configForms.get<ModelFavoritesSection>(MODEL_FAVORITES_NS)
    this.unsubscribe = this.form.subscribe(() => { this.publish() })
    this.publish()
  }

  /** @returns the current membership snapshot. */
  getSnapshot(): ModelFavoritesState {
    return this.store.getSnapshot()
  }

  /**
   * Toggle one pair. The store updates synchronously (optimistic) so the UI
   * reacts on click; persistence is serialized so rapid clicks cannot clobber
   * each other. A refused write reverts to the server-known list.
   * @param provider - provider (catalog group) id.
   * @param model - provider-owned model id.
   * @returns whether the Host accepted the write.
   */
  toggle(provider: string, model: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const base = this.optimistic ?? this.serverFavorites()
    const key = favoriteKey(provider, model)
    const exists = base.some(fav => favoriteKey(fav.provider, fav.model) === key)
    const next = exists
      ? base.filter(fav => favoriteKey(fav.provider, fav.model) !== key)
      : [...base, { provider, model }]
    this.optimistic = next
    this.publish()
    const run = this.tail.then(() => this.persist(next))
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /** Stop following the form; later publishes leave the snapshot alone. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /** The last list the Host answered with. */
  private serverFavorites(): ModelFavorite[] {
    return this.form.getSnapshot().value?.favorites ?? []
  }

  /** Reconcile the store from the optimistic overlay (else the form). */
  private publish(): void {
    if (this.disposed) return
    const snapshot = this.form.getSnapshot()
    const favorites = this.optimistic ?? (snapshot.value === undefined ? null : snapshot.value.favorites ?? [])
    if (favorites === null) {
      this.store.update((draft) => {
        draft.status = snapshot.status === 'unavailable' ? 'unavailable' : 'loading'
      })
      return
    }
    this.store.update((draft) => {
      draft.status = 'ready'
      draft.favorites = [...favorites]
    })
  }

  private async persist(next: ModelFavorite[]): Promise<boolean> {
    if (this.disposed) return false
    this.pending += 1
    let ok = false
    try {
      ok = await this.form.set('favorites', next)
    } catch (error) {
      this.pending -= 1
      if (this.optimistic === next) {
        this.optimistic = null
        this.publish()
      }
      throw error
    }
    this.pending -= 1
    if (this.optimistic === next) {
      // Clear the overlay only once this is the latest intent, no write is
      // still in flight, and the Host answer already matches it.
      if (!ok || (this.pending === 0 && sameFavorites(this.serverFavorites(), next))) {
        this.optimistic = null
      }
    }
    this.publish()
    return ok
  }
}
