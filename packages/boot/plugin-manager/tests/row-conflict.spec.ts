/** Duplicate inserted row ids and the module identity that decides whether another layer provides them. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  addedRows, bareModuleDir, collidingRows, duplicateEntryDiagnostic, insertedRows, moduleIdentity, patchInsertedRows, providingLayers,
  repeatedRowIds, rowIdentity, type RowLayer,
} from '../src/row-conflict.ts'

const named = (row: EntryOptions): string => row.name

it('collects inserted rows with their parent group, including group containers, group children and disabled rows', () => {
  expect(insertedRows([
    { id: 'a', name: 'pkg-a' },
    { id: 'off', name: 'pkg-off', disabled: true },
    // A row the composition never gave an id to addresses no plugin of its own.
    { name: 'anonymous' } as EntryOptions,
    { id: 'panel', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'pkg-child' }] },
  ], named)).toEqual([
    { rowId: 'a', specifier: 'pkg-a', moduleKey: 'pkg-a', parent: null, group: false },
    { rowId: 'off', specifier: 'pkg-off', moduleKey: 'pkg-off', parent: null, group: false },
    { rowId: 'panel', specifier: 'cordis:group', moduleKey: 'cordis:group', parent: null, group: true },
    { rowId: 'child', specifier: 'pkg-child', moduleKey: 'pkg-child', parent: 'panel', group: false },
  ])
})

it('reads the rows a layer declares, whether it appends them or inserts them into an existing group', () => {
  expect(patchInsertedRows([
    { insert: [{ id: 'root-row', name: 'pkg-root' }] },
    { id: 'panel', insert: [{ id: 'panel-child', name: 'pkg-child' }] },
    { id: 'other', config: { value: 1 } },
  ], named, new Map([['panel', true]]))).toEqual([
    { rowId: 'root-row', specifier: 'pkg-root', moduleKey: 'pkg-root', parent: null, group: false },
    { rowId: 'panel-child', specifier: 'pkg-child', moduleKey: 'pkg-child', parent: 'panel', group: false },
  ])
})

it('accepts a group-target insert only when the target is a group that exists by then', () => {
  expect(patchInsertedRows([
    { id: 'panel', insert: [{ id: 'child-a', name: 'pkg-a' }] },
    { id: 'row', insert: [{ id: 'child-b', name: 'pkg-b' }] },
    { id: 'absent', insert: [{ id: 'child-c', name: 'pkg-c' }] },
    { insert: [{ id: 'own', group: true, name: 'cordis:group' }] },
    { id: 'own', insert: [{ id: 'child-d', name: 'pkg-d' }] },
  ], named, new Map([['panel', true], ['row', false]]))).toEqual([
    { rowId: 'child-a', specifier: 'pkg-a', moduleKey: 'pkg-a', parent: 'panel', group: false },
    { rowId: 'own', specifier: 'cordis:group', moduleKey: 'cordis:group', parent: null, group: true },
    { rowId: 'child-d', specifier: 'pkg-d', moduleKey: 'pkg-d', parent: 'own', group: false },
  ])
})

it('canonicalizes a package reached through a link and one that names itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'row-conflict-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const physical = join(root, 'enhancement')
  mkdirSync(physical, { recursive: true })
  writeFileSync(join(physical, 'package.json'), JSON.stringify({
    name: '@fixture/memory-enhancement', version: '1.0.0', exports: { '.': './index.mjs' },
  }))
  const linked = join(root, 'starter', 'node_modules', '@fixture', 'memory-enhancement')
  mkdirSync(dirname(linked), { recursive: true })
  symlinkSync(physical, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const starterBase = pathToFileURL(join(root, 'starter', 'package.json')).href
  const throughLink = bareModuleDir('@fixture/memory-enhancement', starterBase, undefined, () => linked)
  // The package's own manifest names it, which Node resolves without the profile's node_modules.
  const bySelf = bareModuleDir('@fixture/memory-enhancement', pathToFileURL(join(physical, 'package.json')).href,
    { name: '@fixture/memory-enhancement', dir: physical }, () => undefined)
  expect(throughLink).toBe(realpathSync(physical))
  expect(bySelf).toBe(realpathSync(physical))
  // Another physical package carrying the same name is still another module.
  const copy = join(root, 'copy')
  mkdirSync(copy, { recursive: true })
  expect(bareModuleDir('@fixture/memory-enhancement', starterBase, undefined, () => copy)).not.toBe(throughLink)
  // An unresolved name stays unresolved for a package that is not the layer's own.
  expect(bareModuleDir('@fixture/absent', starterBase, { name: '@fixture/memory-enhancement', dir: physical }, () => undefined))
    .toBeUndefined()
})

it('identifies a module by its resolved file or package, never by a relative specifier alone', () => {
  expect(moduleIdentity('cordis:manager', 'file:///profile/package.json', () => '/pkg')).toBe('cordis:manager')
  expect(moduleIdentity('file:///bundle-a/plugin.mjs', 'file:///profile/package.json', () => '/pkg')).toBe('file:///bundle-a/plugin.mjs')
  expect(moduleIdentity('./plugin.mjs', 'file:///bundle-a/package.json', () => '/pkg')).toBe('file:///bundle-a/plugin.mjs')
  expect(moduleIdentity('/abs/plugin.mjs', 'file:///profile/package.json', () => '/pkg')).toBe(pathToFileURL('/abs/plugin.mjs').href)
  // The same relative specifier in two layers names two files, so neither provides the other.
  expect(moduleIdentity('./plugin.mjs', 'file:///bundle-b/package.json', () => '/pkg')).not.toBe(moduleIdentity('./plugin.mjs', 'file:///bundle-a/package.json', () => '/pkg'))
  // A bare name resolves through the owning layer; an unresolved one stays that layer's own request.
  expect(moduleIdentity('fixture-bare', 'file:///bundle-a/package.json', () => '/pkg/fixture-bare')).toBe('/pkg/fixture-bare#fixture-bare')
  expect(moduleIdentity('fixture-bare', 'file:///bundle-b/package.json', () => undefined)).toBe('file:///bundle-b/package.json#fixture-bare')
})

it('identifies a row by its id, parent group, and written module', () => {
  const root = { rowId: 'shared', specifier: 'cordis:manager', parent: null }
  expect(rowIdentity(root)).toBe(rowIdentity({ rowId: 'shared', specifier: 'cordis:manager', parent: null }))
  expect(rowIdentity(root)).not.toBe(rowIdentity({ rowId: 'shared', specifier: 'cordis:other', parent: null }))
  expect(rowIdentity(root)).not.toBe(rowIdentity({ rowId: 'shared', specifier: 'cordis:manager', parent: 'panel' }))
})

it('marks each declared row with whether the composition already holds its id', () => {
  expect(addedRows([
    { rowId: 'existing', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: 'panel', group: false },
    { rowId: 'fresh', specifier: './plugin.mjs', moduleKey: 'file:///bundle/plugin.mjs', parent: null, group: false },
  ], new Set(['existing']))).toEqual([
    { rowId: 'existing', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: 'panel', group: false, existed: true },
    { rowId: 'fresh', specifier: './plugin.mjs', moduleKey: 'file:///bundle/plugin.mjs', parent: null, group: false, existed: false },
  ])
})

it('reports a collision for an added row whose id already existed, naming every layer that inserts it', () => {
  const added = [
    { rowId: 'shared', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false, existed: true },
    { rowId: 'own', specifier: './plugin.mjs', moduleKey: './plugin.mjs', parent: 'panel', group: false, existed: true },
    { rowId: 'fresh', specifier: './plugin.mjs', moduleKey: './plugin.mjs', parent: null, group: false, existed: false },
  ]
  const layers: RowLayer[] = [
    { layer: 'core', rows: [{ rowId: 'shared', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false }, { rowId: 'own', specifier: 'cordis:own', moduleKey: 'cordis:own', parent: null, group: false }] },
    { layer: 'profile', rows: [{ rowId: 'shared', specifier: 'cordis:manager', moduleKey: 'uuid:shared', parent: 'panel', group: false }] },
  ]
  expect(collidingRows(added, layers)).toEqual([{ rowId: 'shared', layers: ['core', 'profile'] }, { rowId: 'own', layers: ['core'] }])
})

it('reports a duplicated group container even though it holds no component', () => {
  const added = [{ rowId: 'panel', specifier: 'cordis:group', moduleKey: 'cordis:group', parent: null, group: true, existed: true }]
  const layers: RowLayer[] = [{ layer: 'grouped', rows: [{ rowId: 'panel', specifier: 'cordis:group', moduleKey: 'cordis:group', parent: null, group: true }] }]
  expect(collidingRows(added, layers)).toEqual([{ rowId: 'panel', layers: ['grouped'] }])
})

it('names no layer for a duplicated id no attributed layer inserts', () => {
  const layers: RowLayer[] = [{ layer: 'core', rows: [{ rowId: 'other', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false }] }]
  expect(collidingRows([{ rowId: 'shared', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false, existed: true }], layers))
    .toEqual([{ rowId: 'shared', layers: [] }])
})

it('reports one id a layer inserts twice itself, naming that layer', () => {
  const layers: RowLayer[] = [{ layer: 'core', rows: [{ rowId: 'other', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false }] }]
  const added = [
    { rowId: 'twice', specifier: './plugin.mjs', moduleKey: './plugin.mjs', parent: null, group: false, existed: false },
    { rowId: 'twice', specifier: './plugin.mjs', moduleKey: './plugin.mjs', parent: null, group: false, existed: false },
  ]
  expect(collidingRows(added, layers, 'duplicating')).toEqual([{ rowId: 'twice', layers: ['duplicating'] }])
  // Without the applied layer's name the collision is still reported.
  expect(collidingRows(added, layers)).toEqual([{ rowId: 'twice', layers: [] }])
})

it('names the single layer that inserts every added component under the same id and resolved module', () => {
  const added = [
    { rowId: 'a', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false, existed: true },
    { rowId: 'b', specifier: 'fixture-b', moduleKey: '/pkg/b#fixture-b', parent: null, group: false, existed: true },
  ]
  const layers: RowLayer[] = [
    { layer: 'partial', rows: [{ rowId: 'a', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false }] },
    { layer: 'twin', rows: [
      { rowId: 'a', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false },
      { rowId: 'b', specifier: 'fixture-b', moduleKey: '/pkg/b#fixture-b', parent: null, group: false },
    ] },
    { layer: 'other-module', rows: [
      { rowId: 'a', specifier: 'cordis:other', moduleKey: 'cordis:other', parent: null, group: false },
      { rowId: 'b', specifier: 'fixture-b', moduleKey: '/pkg/b#fixture-b', parent: null, group: false },
    ] },
    { layer: 'group-only', rows: [{ rowId: 'a', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: true }] },
  ]
  expect(providingLayers(added, layers)).toEqual(['twin'])
})

it('names no provider without an added component', () => {
  expect(providingLayers([], [{ layer: 'core', rows: [{ rowId: 'a', specifier: 'cordis:manager', moduleKey: 'cordis:manager', parent: null, group: false }] }])).toEqual([])
  // A duplicated group container is a conflict, not a provided component.
  expect(providingLayers([{ rowId: 'panel', specifier: 'cordis:group', moduleKey: 'cordis:group', parent: null, group: true, existed: true }],
    [{ layer: 'grouped', rows: [{ rowId: 'panel', specifier: 'cordis:group', moduleKey: 'cordis:group', parent: null, group: true }] }])).toEqual([])
})

it('reports only the ids a composition really holds more than once', () => {
  expect(repeatedRowIds([
    { id: 'once', name: 'pkg-once' },
    { id: 'twice', name: 'pkg-twice' },
    { id: 'twice', name: 'pkg-twice' },
    { id: 'panel', name: 'cordis:group', group: true, config: [{ id: 'panel', name: 'cordis:group', group: true }] },
  ])).toEqual(new Set(['twice', 'panel']))
})

it('names a layer once when one layer inserts the same id twice', () => {
  const row = (): RowLayer['rows'][number] =>
    ({ rowId: 'twice', specifier: './plugin.mjs', moduleKey: './plugin.mjs', parent: null, group: false })
  const layers: RowLayer[] = [{ layer: 'core', rows: [row(), row()] }]
  expect(collidingRows([{ ...row(), existed: true }], layers)).toEqual([{ rowId: 'twice', layers: ['core'] }])
})

it('words each collision as the row and the layers that already insert it, once per id', () => {
  expect(duplicateEntryDiagnostic([
    { rowId: 'shared', layers: ['core', 'extra'] },
    { rowId: 'own', layers: ['core'] },
    { rowId: 'shared', layers: ['core', 'extra'] },
    { rowId: 'orphan', layers: [] },
  ])).toBe('shared is already inserted by core, extra; own is already inserted by core; orphan is already inserted by an existing configuration layer')
})
