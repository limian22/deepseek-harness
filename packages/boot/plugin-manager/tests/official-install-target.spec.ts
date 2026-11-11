/** Official installation targets follow the actual CLI installation and its workspace packages. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { officialBundleInstallTargets } from '../src/official-install-target.ts'

const name = '@deepseek-ai/dsh-subagent-codex'
const other = '@deepseek-ai/dsh-subagent-claude-code'
const version = '0.2.1-alpha.1'

const work = vi.hoisted(() => ({ globs: 0, manifestReads: 0, packageRoot: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const workspaceManifest = (file: unknown): boolean => typeof file === 'string'
    && work.packageRoot !== '' && file.startsWith(work.packageRoot) && file.endsWith('package.json')
  return {
    ...actual,
    globSync: ((...args: Parameters<typeof actual.globSync>) => {
      work.globs += 1
      return actual.globSync(...args)
    }) as typeof actual.globSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (workspaceManifest(args[0])) work.manifestReads += 1
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
  }
})

/** Count the source-workspace scans and manifests the next resolutions read. */
function workspaceWork() {
  work.globs = 0
  work.manifestReads = 0
  return { globCalls: () => work.globs, manifestReads: () => work.manifestReads }
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'official-target-'))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = realpathSync(temporary)
  work.packageRoot = join(root, 'packages') + sep
  const anchor = join(root, 'apps', 'cli', 'package.json')
  mkdirSync(dirname(anchor), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { '@deepseek-ai/dsh-app-boot': 'workspace:*' } }))
  const directory = join(root, 'packages', 'relocated', 'native-provider')
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(directory, 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
  return { root, anchor, directory }
}

/** One fixture with a workspace package for each of two offered names. */
function twoNameFixture() {
  const { root, anchor, directory } = fixture()
  const second = join(root, 'packages', 'relocated', 'native-provider-two')
  mkdirSync(join(second, 'lib'), { recursive: true })
  writeFileSync(join(second, 'package.json'), JSON.stringify({ name: other, version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(second, 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(second, 'cordis.patch.yml'), '[]\n')
  return { root, anchor, directory, second }
}

function target(anchor: string, packageName: string = name) {
  return officialBundleInstallTargets(anchor, version)(packageName)
}

it('offers an exact prerelease registry target for a packed installation inside a checkout', () => {
  const { anchor } = fixture()
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { '@deepseek-ai/dsh-app-boot': version } }))
  expect(target(anchor)).toEqual({ spec: `${name}@${version}`, version })
})

it('keeps an installation without workspace dependencies on the registry path', () => {
  const { anchor } = fixture()
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  expect(target(anchor)).toEqual({ spec: `${name}@${version}`, version })
})

it('finds the package by manifest name rather than assuming its workspace directory', () => {
  const { anchor, directory } = fixture()
  expect(target(anchor)).toEqual({ spec: `link:${directory}`, version })
})

it('follows the CLI directory link used by an unpackaged Desktop application', () => {
  const { root, anchor, directory } = fixture()
  const link = join(root, 'desktop-runtime', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(dirname(anchor), link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(target(join(link, 'package.json'))).toEqual({ spec: `link:${directory}`, version })
})

it.each(['missing', 'wrong-name', 'wrong-location'])('refuses a source CLI with a %s workspace root', (kind) => {
  const { root, anchor } = fixture()
  if (kind === 'missing') rmSync(join(root, 'package.json'))
  if (kind === 'wrong-name') writeFileSync(join(root, 'package.json'), '{"name":"unrelated"}')
  const selected = kind === 'wrong-location' ? join(root, 'package.json') : anchor
  if (kind === 'wrong-location') writeFileSync(selected, readFileSync(anchor))
  expect(() => target(selected)).toThrow('requires its complete workspace checkout')
})

it.each(['missing', 'duplicate'])('refuses a %s workspace package without offering a registry fallback', (kind) => {
  const { root, anchor, directory } = fixture()
  if (kind === 'missing') rmSync(directory, { recursive: true })
  else {
    const duplicate = join(root, 'packages', 'elsewhere', 'duplicate')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(join(duplicate, 'package.json'), readFileSync(join(directory, 'package.json')))
  }
  expect(() => target(anchor)).toThrow('expected one workspace package')
})

it.each([
  { version: '0.1.0' }, { private: true }, { dsh: {} },
])('refuses a workspace package with invalid release or bundle metadata: %j', (changes) => {
  const { anchor, directory } = fixture()
  const file = join(directory, 'package.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...changes }))
  expect(() => target(anchor)).toThrow('must declare a public bundle at DSH version')
})

it.each(['missing-main', 'missing-output', 'directory-output'])('refuses an unbuilt workspace package: %s', (kind) => {
  const { anchor, directory } = fixture()
  if (kind === 'missing-main') {
    const file = join(directory, 'package.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), main: undefined }))
  } else {
    const output = join(directory, 'lib', 'index.js')
    rmSync(output)
    if (kind === 'directory-output') mkdirSync(output)
  }
  expect(() => target(anchor)).toThrow('run pnpm install and pnpm run build')
})

it.each(['missing', 'directory'])('refuses an unavailable bundle patch: %s', (kind) => {
  const { anchor, directory } = fixture()
  const patch = join(directory, 'cordis.patch.yml')
  rmSync(patch)
  if (kind === 'directory') mkdirSync(patch)
  expect(() => target(anchor)).toThrow('bundle patch')
})

it('reads the source workspace once while offering two names', () => {
  const { anchor, directory, second } = twoNameFixture()
  const resolve = officialBundleInstallTargets(anchor, version)
  const counted = workspaceWork()
  expect(resolve(name)).toEqual({ spec: `link:${directory}`, version })
  expect(resolve(other)).toEqual({ spec: `link:${second}`, version })
  expect(counted.globCalls()).toBe(1)
  expect(counted.manifestReads()).toBe(2)
})

it('spends no workspace scan on a packed installation', () => {
  const { anchor } = fixture()
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  const resolve = officialBundleInstallTargets(anchor, version)
  const counted = workspaceWork()
  expect(resolve(name)).toEqual({ spec: `${name}@${version}`, version })
  expect(resolve(other)).toEqual({ spec: `${other}@${version}`, version })
  expect(counted.globCalls()).toBe(0)
  expect(counted.manifestReads()).toBe(0)
})

it('reads the installation again for a later resolver and keeps per-name validation fresh', () => {
  const { anchor, directory } = twoNameFixture()
  expect(officialBundleInstallTargets(anchor, version)(name)).toEqual({ spec: `link:${directory}`, version })
  const later = officialBundleInstallTargets(anchor, version)
  const counted = workspaceWork()
  expect(later(name)).toEqual({ spec: `link:${directory}`, version })
  expect(counted.globCalls()).toBe(1)
  expect(counted.manifestReads()).toBe(2)
  rmSync(join(directory, 'lib', 'index.js'))
  const later2 = officialBundleInstallTargets(anchor, version)
  expect(() => later2(name)).toThrow('run pnpm install and pnpm run build')
})

it('validates each offered name separately within one workspace scan', () => {
  const { root, anchor, directory } = twoNameFixture()
  const duplicate = join(root, 'packages', 'elsewhere', 'duplicate')
  mkdirSync(duplicate, { recursive: true })
  writeFileSync(join(duplicate, 'package.json'), JSON.stringify({ name: other, version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const resolve = officialBundleInstallTargets(anchor, version)
  const counted = workspaceWork()
  expect(resolve(name)).toEqual({ spec: `link:${directory}`, version })
  expect(() => resolve(other)).toThrow(`Official bundle ${other}: expected one workspace package`)
  expect(counted.globCalls()).toBe(1)
})

it('establishes an incomplete checkout again so every name reports itself', () => {
  const { root, anchor, directory, second } = twoNameFixture()
  rmSync(join(root, 'package.json'))
  const resolve = officialBundleInstallTargets(anchor, version)
  expect(() => resolve(name)).toThrow(`Official bundle ${name}: source DSH installation`)
  expect(() => resolve(other)).toThrow(`Official bundle ${other}: source DSH installation`)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  expect(resolve(other)).toEqual({ spec: `link:${second}`, version })
  expect(resolve(name)).toEqual({ spec: `link:${directory}`, version })
})

it('establishes the installation again after an unreadable anchor', () => {
  const { anchor, directory } = twoNameFixture()
  const resolve = officialBundleInstallTargets(anchor, version)
  rmSync(anchor)
  expect(() => resolve(name)).toThrow()
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { '@deepseek-ai/dsh-app-boot': 'workspace:*' } }))
  expect(resolve(name)).toEqual({ spec: `link:${directory}`, version })
})
