/** Shared identity of one pinned model, compiled by both the host and client halves. */

/** One pinned provider/model pair, matched by the selection ids. */
export interface ModelFavorite {
  /** Provider (catalog group) id owning the model. */
  provider: string
  /** Provider-owned model id. */
  model: string
}
