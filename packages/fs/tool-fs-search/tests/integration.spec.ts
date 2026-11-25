/**
 * Integration tests: the REAL local subprocess service plus the PACKAGED
 * ripgrep binary (`@vscode/ripgrep`), exercised through `executeToolFixture()`.
 * These verify the WORLD — actual files on disk are discovered and grepped,
 * hostile patterns stay inert (they are plain argv elements; there is no
 * shell layer to escape), and real `rg` stderr classifies into the
 * `SEARCH_*` vocabulary. The binary ships inside the npm dependency, so the
 * suite runs on every platform without a system `rg` install; the
 * fake-service suite (tools.spec.ts) carries the coverage gate.
 */
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context

let callCounter = 0
function call(name: string, args: unknown, agentObj?: object) {
  return executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: brandString<ToolCallId>(`it-${++callCounter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** The fixture workspace as a session cwd, so relative paths resolve inside `dir`. */
const agent = () => ({ session: { header: { id: 'session-int', cwd: dir } } })

describe('search tools over the real subprocess service + the packaged rg', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-search-int-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'spaced dir'), { recursive: true })
    await writeFile(join(dir, 'src', 'alpha.ts'), 'export const alpha = 1\n// TODO: refit alpha\n')
    await writeFile(join(dir, 'src', 'beta.ts'), 'export const beta = 2\n')
    await writeFile(join(dir, 'notes.md'), 'alpha appears here too\n')
    await writeFile(join(dir, '.hidden.ts'), 'export const hidden = 3\n')
    await writeFile(join(dir, '.git', 'config.ts'), 'never listed\n')
    await writeFile(join(dir, 'spaced dir', "wei'rd name.ts"), 'const inside = true\n')
    // Deterministic --sort=modified order: alpha oldest, beta newest.
    await utimes(join(dir, 'src', 'alpha.ts'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    await utimes(join(dir, 'src', 'beta.ts'), new Date(2020, 0, 1), new Date(2020, 0, 1))

    ctx = new Context()

    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it.each(['glob', 'grep'])('%s anchors directory filters to an explicit in-workspace root', async (name) => {
    await mkdir(join(dir, '[project]', 'src'), { recursive: true })
    await mkdir(join(dir, '[project]', 'nested', 'src'), { recursive: true })
    await mkdir(join(dir, 'sibling', 'src'), { recursive: true })
    await writeFile(join(dir, '[project]', 'src', 'one.ts'), 'marker\n')
    await writeFile(join(dir, '[project]', 'nested', 'src', 'two.ts'), 'marker\n')
    await writeFile(join(dir, 'sibling', 'src', 'three.ts'), 'marker\n')
    for (const path of ['[project]', join(dir, '[project]')]) {
      const args = name === 'glob' ? { path, pattern: 'src/*.ts' } : { path, pattern: 'marker', include: 'src/*.ts' }
      const result = await call(name, args, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toContain(join('[project]', 'src', 'one.ts'))
      expect(text(result)).not.toContain('two.ts')
      expect(text(result)).not.toContain('three.ts')
    }
  })

  it.each(['glob', 'grep'])('%s preserves depth, basename, ignore rules and output coordinates', async (name) => {
    await mkdir(join(dir, 'project', 'src'), { recursive: true })
    await mkdir(join(dir, 'project', 'nested', 'src'), { recursive: true })
    await writeFile(join(dir, 'project', 'src', 'a.ts'), 'marker\n')
    await writeFile(join(dir, 'project', 'nested', 'src', 'b.ts'), 'marker\n')
    await writeFile(join(dir, 'project', 'src', 'ignored.ts'), 'marker\n')
    await writeFile(join(dir, '.gitignore'), 'project/src/ignored.ts\n')
    const run = async (filter: string) => call(name, name === 'glob'
      ? { path: 'project', pattern: filter }
      : { path: 'project', pattern: 'marker', include: filter }, agent())
    const direct = text(await run('/src/*.ts'))
    expect(direct).toContain(join('project', 'src', 'a.ts'))
    expect(direct).not.toContain('b.ts')
    // Positive ripgrep globs can override ignore rules; compare with the same
    // filter relative to a session whose cwd is the explicit root.
    const control = await call(name, name === 'glob'
      ? { pattern: '/src/*.ts' }
      : { pattern: 'marker', include: '/src/*.ts' },
    { session: { header: { id: 'control', cwd: join(dir, 'project') } } })
    expect(direct.includes('ignored.ts')).toBe(text(control).includes('ignored.ts'))
    const recursive = text(await run('**/src/*.ts'))
    expect(recursive).toContain(join('project', 'nested', 'src', 'b.ts'))
    const basename = text(await run('*.ts'))
    expect(basename).toContain(join('project', 'nested', 'src', 'b.ts'))
    if (name === 'grep') expect(direct).toContain('Line 1: marker')
  }, 15_000)

  it('keeps scoped glob negation and rejects grep negation', async () => {
    await mkdir(join(dir, 'project', 'src'), { recursive: true })
    await mkdir(join(dir, 'project', 'other'), { recursive: true })
    await writeFile(join(dir, 'project', 'src', 'a.ts'), 'marker\n')
    await writeFile(join(dir, 'project', 'other', 'b.ts'), 'marker\n')
    const result = await call('glob', { path: 'project', pattern: '!src/*.ts' }, agent())
    expect(text(result)).not.toContain('a.ts')
    expect(text(result)).toContain('b.ts')
    const rejected = await call('grep', { path: 'project', pattern: 'marker', include: '!src/*.ts' }, agent())
    expect(rejected.error).toMatchObject({ info: { code: 'INVALID_ARGS' } })
  })

  describe('glob', () => {
    it('prunes unrelated directories and preserves workspace-relative results', async () => {
      await mkdir(join(dir, 'packages', 'core', 'src', 'nested'), { recursive: true })
      await writeFile(join(dir, 'packages', 'core', 'src', 'old.ts'), '')
      await writeFile(join(dir, 'packages', 'core', 'src', '.hidden.ts'), '')
      await writeFile(join(dir, 'packages', 'core', 'src', 'nested', 'other.ts'), '')
      await mkdir(join(dir, 'packages', 'src', 'core'), { recursive: true })
      await writeFile(join(dir, 'packages', 'src', 'core', 'other.ts'), '')
      await writeFile(join(dir, '.gitignore'), 'packages/\n')
      await utimes(join(dir, 'packages', 'core', 'src', 'old.ts'), new Date(2000, 0, 1), new Date(2000, 0, 1))
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
      const result = await call('glob', { pattern: 'packages/core/src/*.ts' }, agent())
      expect(ensure).toHaveBeenCalledTimes(1)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected glob success')
      expect(result.value).toEqual({ root: '.', paths: [
        join('packages', 'core', 'src', '.hidden.ts'),
        join('packages', 'core', 'src', 'old.ts'),
      ] })
      expect(spawn.mock.calls[0]?.[0].argv.slice(3, 6)).toEqual([
        '--glob=!**', '--glob={packages,core,src}/', '--glob=packages/core/src/*.ts',
      ])
      expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--')
    })

    it.each(['*.ts', '**/*.ts', 'src/**/*.ts', '!src/*.ts', './src/*.ts', 'src/../src/*.ts', '.git/*.ts'])(
      'keeps the original traversal for %s', async (pattern) => {
        const spawn = vi.spyOn(ctx.subprocess, 'spawn')
        const result = await call('glob', { pattern }, agent())
        expect(result.isError).toBe(false)
        expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--glob=!**')
      },
    )

    it.each(['missing/*.ts', 'notes.md/*.ts', 'src/alpha.ts/*.ts'])('reports no matches when a literal prefix names a missing directory or file: %s', async (pattern) => {
      const result = await call('glob', { pattern }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toBe('No files found')
    })

    it.each([[1, 8170, 8192], [1, 8171, 0], [1500, 1, 23], [16, 240, 262]])('keeps %i directories of length %i searchable through Native execution', async (depth, length, pruningBytes) => {
      const pattern = `${Array.from({ length: depth }, () => 'a'.repeat(length)).join('/')}/*.ts`
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await executeModelToolFixture(ctx, {
        signal: testToolSignal,
        callId: brandString<ToolCallId>(`deep-glob-${++callCounter}`),
        name: 'glob',
        arguments: { pattern },
        agent: agent() as never,
      })
      expect(result.isError).toBe(false)
      expect(text(result)).toBe('No files found')
      const argv = spawn.mock.calls[0]?.[0].argv ?? []
      const pruning = argv.slice(3, argv.indexOf(`--glob=${pattern}`))
      expect(pruning.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0)).toBe(pruningBytes)
    })

    it('preserves case-sensitive matching while pruning directories', async () => {
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      expect(text(await call('glob', { pattern: 'SRC/*.ts' }, agent()))).toBe('No files found')
      expect(spawn.mock.calls[0]?.[0].argv).toContain('--glob={SRC}/')
    })

    it('prunes without adding a search root or following a directory link', async () => {
      await mkdir(join(dir, 'src', 'nested'))
      await writeFile(join(dir, 'src', 'nested', 'file.ts'), '')
      await symlink(join(dir, 'src'), join(dir, 'linked'), 'junction')
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      expect(text(await call('glob', { pattern: 'linked/nested/*.ts' }, agent()))).toBe('No files found')
      expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--')
    })

    it('discovers files by pattern, sorted by path, hidden included, .git excluded', async () => {
      const result = await call('glob', { pattern: '**/*.ts' }, agent())
      expect(result.isError).toBe(false)
      const paths = text(result).split('\n')
      expect(paths).toEqual([...paths].sort())
      expect(paths).toContain('.hidden.ts')
      expect(paths).toContain(join('spaced dir', "wei'rd name.ts"))
      expect(paths).not.toContain(join('.git', 'config.ts'))
      expect(paths).not.toContain('notes.md')
    })

    it('uses modification-time order only when requested', async () => {
      await utimes(join(dir, 'src', 'beta.ts'), new Date(1990, 0, 1), new Date(1990, 0, 1))
      const input = { pattern: '*.ts', path: 'src' }
      const oldest = join('src', 'beta.ts')
      const newest = join('src', 'alpha.ts')
      expect(text(await call('glob', input, agent()))).toBe(`${newest}\n${oldest}`)
      expect(text(await call('glob', { ...input, sort: 'modified' }, agent()))).toBe(`${oldest}\n${newest}`)
    })

    it('scopes to a directory search root (path arg)', async () => {
      const result = await call('glob', { pattern: '*.ts', path: 'src' }, agent())
      expect(text(result).split('\n').sort()).toEqual([join('src', 'alpha.ts'), join('src', 'beta.ts')])
    })

    it('keeps an explicit path as the only search root when the pattern has a literal prefix', async () => {
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await call('glob', { pattern: 'src/*.ts', path: '.' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result).split('\n')).toEqual(['alpha.ts', 'beta.ts'].map(name => `.${sep}${join('src', name)}`))
      const argv = spawn.mock.calls[0]?.[0].argv
      expect(argv?.filter(part => part === '--')).toHaveLength(1)
      expect(argv?.slice(-2)).toEqual(['--', '.'])
      expect(argv).not.toContain('--glob=!**')
    })

    it('discovers files in a directory named dash without treating it as stdin', async () => {
      await mkdir(join(dir, '-'))
      await writeFile(join(dir, '-', 'file.ts'), '')
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await call('glob', { pattern: '-/*.ts' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toBe(join('-', 'file.ts'))
      expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--')
    })

    it('reports zero discoveries as No files found', async () => {
      expect(text(await call('glob', { pattern: '*.nomatch' }, agent()))).toBe('No files found')
    })

    it('excludes VCS internals even when the search root IS the VCS directory', async () => {
      // The prune glob alone never matches root-prefixed paths when rg is
      // rooted at .git; the paired contents glob keeps the exclusion airtight.
      expect(text(await call('glob', { pattern: '*', path: '.git' }, agent()))).toBe('No files found')
    })

    it('classifies an invalid glob as SEARCH_INVALID_PATTERN', async () => {
      const result = await call('glob', { pattern: '[' }, agent())
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'SearchError', code: 'SEARCH_INVALID_PATTERN' } })
    })
  })

  describe('grep', () => {
    it.each([undefined, ''])('greps without a file filter when include is %j', async (include) => {
      const result = await call('grep', { pattern: 'alpha', ...include !== undefined ? { include } : {} }, agent())
      expect(result.isError).toBe(false)
      const output = text(result)
      expect(output).toContain('Found 3 matches')
      expect(output).toContain(`${join('src', 'alpha.ts')}\nLine 1: export const alpha = 1\nLine 2: // TODO: refit alpha`)
      expect(output).toContain('notes.md\nLine 1: alpha appears here too')
    })

    it('greps a single FILE target', async () => {
      const result = await call('grep', { pattern: 'alpha', path: 'notes.md' }, agent())
      expect(text(result)).toBe('Found 1 match\n\nnotes.md\nLine 1: alpha appears here too')
    })

    it('greps a directory target with an include filter', async () => {
      const result = await call('grep', { pattern: 'alpha', path: '.', include: '*.ts' }, agent())
      const output = text(result)
      expect(output).toContain('alpha.ts')
      expect(output).not.toContain('notes.md')
    })

    it('a hostile pattern stays inert (a plain argv element, the world untouched)', async () => {
      // There is no shell layer between the argv vector and rg, so the pattern
      // is a literal regex — but the world-untouched guarantee is the shipped
      // contract, and a future shell-wrapping change must not reintroduce it.
      // The canary name carries no path so the regex stays valid on every
      // platform (a Windows path's backslashes would be regex escapes).
      const canary = join(dir, 'pwned')
      const result = await call('grep', { pattern: '$(touch pwned)' }, agent())
      expect(result.isError).toBe(false) // exit 1: found nothing, executed nothing
      expect(text(result)).toBe('No matches found')
      expect(existsSync(canary)).toBe(false)
    })

    it('a leading-dash pattern is a pattern, not a flag', async () => {
      await writeFile(join(dir, 'dashes.txt'), 'value --flag value\n')
      const result = await call('grep', { pattern: '--flag', path: 'dashes.txt' }, agent())
      expect(text(result)).toBe('Found 1 match\n\ndashes.txt\nLine 1: value --flag value')
    })

    it('classifies a real rg regex error as SEARCH_INVALID_PATTERN', async () => {
      const result = await call('grep', { pattern: '(unclosed' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_INVALID_PATTERN' } })
    })

    it('returns no matches for a valid explicit file without matching content', async () => {
      const result = await call('grep', { pattern: 'no-such-content', path: 'notes.md' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toBe('No matches found')
    })
  })

  describe('missing explicit search paths', () => {
    it.each(['glob', 'grep'])('%s identifies a missing absolute search root without falling back', async (name) => {
      const path = join(dir, 'retired plugin')
      const result = await call(name, { pattern: name === 'glob' ? '**/*.ts' : 'alpha', path }, agent())
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_PATH_NOT_FOUND' } })
      expect(text(result)).toContain(path)
      expect(text(result)).not.toContain('alpha.ts')
    })

    it('reports a missing relative root against the session workspace', async () => {
      const path = join('src', 'retired')
      const result = await call('grep', { pattern: 'alpha', path }, agent())
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_PATH_NOT_FOUND' } })
      expect(text(result)).toContain(join(dir, path))
    })
  })

  describe('per-session cwd', () => {
    it('resolves the search in the SESSION workspace, not the process cwd', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-search-session-'))
      try {
        await writeFile(join(sessionDir, 'only-here.ts'), 'const sessionFile = true\n')
        const agentObj = { session: { header: { id: 'session-int', cwd: sessionDir } } }
        const globbed = await call('glob', { pattern: '*.ts' }, agentObj)
        expect(text(globbed)).toBe('only-here.ts')
        const grepped = await call('grep', { pattern: 'sessionFile' }, agentObj)
        expect(text(grepped)).toContain('only-here.ts\nLine 1: const sessionFile = true')
      } finally {
        await rm(sessionDir, { recursive: true, force: true })
      }
    })
  })

  describe('pre-dispatch cancellation and spawn failures', () => {
    it('a pre-aborted registry call is ABORTED_BEFORE_DISPATCH', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await executeToolFixture(ctx, {
        callId: brandString<ToolCallId>(`it-${++callCounter}`),
        name: 'grep',
        arguments: { pattern: 'x' },
        signal: controller.signal,
      })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } })
    })

    it.each(['*', 'src/*.ts'])('an unusable session cwd provider rejection is SEARCH_FAILED for %s', async (pattern) => {
      const gone = join(dir, 'deleted-session-dir')
      const result = await call('glob', { pattern }, { session: { header: { id: 'session-int', cwd: gone } } })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'SearchError', code: 'SEARCH_FAILED' } })
      expect(text(result)).toContain('subprocess failed before reporting an outcome')
      expect(text(result)).not.toContain('could not start')
    })
  })
})
