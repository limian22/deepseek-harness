/** Inserted row ids a composition holds, and the duplicate ids a newly selected bundle layer would add. */
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** One row a layer inserts: its id, its module, and the group holding it. */
export interface InsertedRow {
  readonly rowId: string
  /** The module specifier as the row writes it; two layers write the same specifier only for the same text. */
  readonly specifier: string
  /** Equal keys mean both rows load the same module; see {@link moduleIdentity}. */
  readonly moduleKey: string
  /** Id of the group holding this row, or null at the composition root. */
  readonly parent: string | null
  /** Whether the row is a group container, whose id patch addressing reaches exactly like a component's. */
  readonly group: boolean
}

/** One inserted row that a new layer would add. */
export interface AddedRow extends InsertedRow {
  /** Whether the composition already held the id, so another layer inserts it too. */
  readonly existed: boolean
}

/** The inserted rows one configuration layer contributes. */
export interface RowLayer {
  /** The layer's name in a diagnostic: a bundle package name or a patch file path. */
  readonly layer: string
  readonly rows: InsertedRow[]
}

/** One id a new layer would insert that the composition already holds, with the layers that insert it. */
export interface RowCollision {
  readonly rowId: string
  /** Layers whose inserted rows carry the id, in application order; empty when no layer could be attributed. */
  readonly layers: string[]
}

/**
 * Identity of the module one row names: the file URL a path or relative specifier resolves to, the resolved package
 * directory plus the specifier for a bare package name, and the owning layer's base plus the specifier when that
 * package cannot be resolved, all under the Loader builtin's own name. Two layers therefore match only when they load
 * the same module: `./plugin.mjs` in two bundle directories, or one bare name resolved from two bundle trees, never
 * matches.
 * @param specifier The row's `name`.
 * @param base The URL whose Node lookup order applies to a bare name, and that a relative specifier resolves against.
 * @param resolvePackage Resolved package directory for a bare specifier, or undefined.
 * @returns The module identity.
 */
export function moduleIdentity(
  specifier: string, base: string, resolvePackage: (specifier: string, base: string) => string | undefined,
): string {
  if (specifier.startsWith('cordis:')) return specifier
  if (specifier.startsWith('file:')) return specifier
  if (specifier.startsWith('.')) return new URL(specifier, base).href
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href
  return `${resolvePackage(specifier, base) ?? base}#${specifier}`
}

/** The package one configuration layer is: its manifest name and physical directory. */
export interface LayerPackage {
  readonly name: string | undefined
  readonly dir: string
}

/**
 * The physical directory of the package a bare specifier names: the layer's own package when it names itself, else the
 * package the resolver finds, canonicalized so two links to one directory agree. Node's own self reference needs an
 * `exports` field; a row naming the package that declares it needs none.
 * @param specifier The row's `name`.
 * @param base The URL whose Node lookup order applies.
 * @param self The layer's own package, when the layer is a package.
 * @param resolvePackage Resolved package directory for a bare specifier, or undefined.
 * @returns The physical package directory, or undefined when nothing resolves the name.
 */
export function bareModuleDir(
  specifier: string, base: string, self: LayerPackage | undefined,
  resolvePackage: (specifier: string, base: string) => string | undefined,
): string | undefined {
  if (self !== undefined && specifier === self.name) return realpathSync(self.dir)
  const dir = resolvePackage(specifier, base)
  return dir === undefined ? undefined : realpathSync(dir)
}

/**
 * Walk composed entries depth first, reporting each row that has an id and a name with the group holding it; a row
 * without either addresses no plugin of its own.
 * @param rows Composed entries.
 * @param parent Id of the group holding these rows, or null at the root.
 * @param keyOf Module identity of one row.
 * @param visit Receives every addressable row, group containers included.
 */
function walk(
  rows: readonly EntryOptions[], parent: string | null, keyOf: (row: EntryOptions) => string, visit: (row: InsertedRow) => void,
): void {
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
    const group = row.group === true
    visit({ rowId: row.id, specifier: row.name, moduleKey: keyOf(row), parent, group })
    if (group && Array.isArray(row.config)) walk(row.config as EntryOptions[], row.id, keyOf, visit)
  }
}

/**
 * Read every inserted row of a composition, group containers and group children included.
 * @param rows Composed entries.
 * @param keyOf Module identity of one row.
 * @returns The inserted rows, depth first.
 */
export function insertedRows(rows: readonly EntryOptions[], keyOf: (row: EntryOptions) => string): InsertedRow[] {
  const inserted: InsertedRow[] = []
  walk(rows, null, keyOf, row => inserted.push(row))
  return inserted
}

/**
 * Read the rows a layer's patches declare through `insert`, following the composition's own acceptance rules: an
 * `insert` naming a group applies only when that group exists by then, so a group an earlier patch of the same layer
 * inserts is addressable and an absent one contributes nothing. The declarations are read from the patches rather than
 * from a composed difference, so a row inserted into a group keeps its own module and parent instead of being confused
 * with an earlier row of the same id.
 * @param patches The layer's patch list in application order.
 * @param keyOf Module identity under this layer's own resolution.
 * @param groups Row ids the composition holds, mapped to whether each is a group.
 * @returns The rows the layer would insert, in declaration order.
 */
export function patchInsertedRows(
  patches: readonly PatchOptions[], keyOf: (row: EntryOptions) => string, groups: ReadonlyMap<string, boolean>,
): InsertedRow[] {
  const known = new Map(groups)
  const inserted: InsertedRow[] = []
  for (const patch of patches) {
    if (patch.insert === undefined) continue
    // A non-insert patch never adds a row; an insert without an id appends at the root.
    const parent = typeof patch.id === 'string' ? patch.id : null
    if (parent !== null && known.get(parent) !== true) continue
    const rows: InsertedRow[] = []
    walk(patch.insert, parent, keyOf, row => rows.push(row))
    for (const row of rows) known.set(row.rowId, row.group)
    inserted.push(...rows)
  }
  return inserted
}

/**
 * Identity of one inserted row inside a composition: its id under its parent group, as the patch writes its module. A
 * later layer that replaces a group's config with a child of the same id but another module therefore owns a distinct row.
 * @param row The inserted row.
 * @returns The identity key.
 */
export function rowIdentity(row: Pick<InsertedRow, 'rowId' | 'specifier' | 'parent'>): string {
  return `${row.parent ?? ''}\u0000${row.rowId}\u0000${row.specifier}`
}

/**
 * Mark the rows a new layer declares with whether the composition already holds their id. An id is the composition's
 * addressing key, so a row under another group or module still collides with it.
 * @param rows The rows a new layer declares.
 * @param existing Ids the composition holds.
 * @returns The added rows, in declaration order.
 */
export function addedRows(rows: readonly InsertedRow[], existing: ReadonlySet<string>): AddedRow[] {
  return rows.map(row => ({ ...row, existed: existing.has(row.rowId) }))
}

/**
 * The added rows the composition already holds by id, and rows the layer inserts more than once, with the layers that
 * insert each id. Every layer that inserts the id is named, whichever group or module it uses.
 * @param added Rows a new layer would add.
 * @param layers The composition's layers and their inserted rows.
 * @param self The layer being applied, named when it inserts one id twice itself.
 * @returns One collision per duplicated added row, in added order.
 */
export function collidingRows(added: readonly AddedRow[], layers: readonly RowLayer[], self?: string): RowCollision[] {
  const inserted = new Map<string, string[]>()
  for (const layer of layers) {
    for (const row of layer.rows) {
      const layersOf = inserted.get(row.rowId)
      if (layersOf === undefined) inserted.set(row.rowId, [layer.layer])
      else if (!layersOf.includes(layer.layer)) layersOf.push(layer.layer)
    }
  }
  const seen = new Map<string, number>()
  return added.flatMap((row) => {
    const index = (seen.get(row.rowId) ?? 0) + 1
    seen.set(row.rowId, index)
    const layersOf = inserted.get(row.rowId) ?? []
    const repeated = !row.existed && index > 1
    if (!row.existed && !repeated) return []
    return [{ rowId: row.rowId, layers: repeated && self !== undefined && !layersOf.includes(self) ? [...layersOf, self] : layersOf }]
  })
}

/**
 * Layers that already insert every added component under the same id and resolved module: the rows a bundle would
 * duplicate rather than add. A group container is not a component, so it neither counts as provided nor provides one.
 * @param added Rows a new layer would add.
 * @param layers Layers that may provide them, normally the selected bundles.
 * @returns The providing layer names in application order; empty without an added component or without a layer
 *   covering all of them.
 */
export function providingLayers(added: readonly AddedRow[], layers: readonly RowLayer[]): string[] {
  const components = added.filter(row => !row.group)
  if (components.length === 0) return []
  return layers
    .filter(layer => components.every(row => layer.rows.some(provided =>
      !provided.group && provided.rowId === row.rowId && provided.moduleKey === row.moduleKey)))
    .map(layer => layer.layer)
}

/**
 * Ids the composition holds more than once: a patch can address an id no more specifically than its last row.
 * @param rows Composed entries.
 * @returns The duplicated ids, group containers included.
 */
export function repeatedRowIds(rows: readonly EntryOptions[]): Set<string> {
  const counts = new Map<string, number>()
  for (const row of insertedRows(rows, () => '')) counts.set(row.rowId, (counts.get(row.rowId) ?? 0) + 1)
  return new Set([...counts].filter(([, count]) => count > 1).map(([rowId]) => rowId))
}

/**
 * The refusal sentence for duplicate ids: each id and the layers that already insert it, stated once per id.
 * @param collisions Collisions found for one layer.
 * @returns One clause per colliding id.
 */
export function duplicateEntryDiagnostic(collisions: readonly RowCollision[]): string {
  const stated = new Set<string>()
  const clauses: string[] = []
  for (const collision of collisions) {
    if (stated.has(collision.rowId)) continue
    stated.add(collision.rowId)
    clauses.push(`${collision.rowId} is already inserted by ${collision.layers.length === 0 ? 'an existing configuration layer' : collision.layers.join(', ')}`)
  }
  return clauses.join('; ')
}
