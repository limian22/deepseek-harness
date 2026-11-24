/**
 * Unit tests for model-facing guarded-mutation diagnostics: normalized unread
 * failures, the stale-version remedy, code preservation, and passthrough.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { remediateFsError } from '../src/error.ts'

describe('remediateFsError', () => {
  it('appends the re-read remedy to FS_STALE_VERSION, preserving the code and chaining the cause', () => {
    const original = new FsError('cannot edit "x": file changed since it was read', 'FS_STALE_VERSION')
    const remedied = remediateFsError(original, 'x')
    expect(remedied).toBeInstanceOf(FsError)
    expect(remedied.message).toBe('cannot edit "x": file changed since it was read — re-read the file, then retry')
    expect(remedied.code).toBe('FS_STALE_VERSION')
    expect(remedied.cause).toBe(original)
  })

  it('normalizes policy and provider FS_NOT_OBSERVED failures to one diagnostic', () => {
    const sources = [
      new FsError('edit requires reading "x" first', 'FS_NOT_OBSERVED'),
      new FsError('cannot overwrite existing "x" without reading it first', 'FS_NOT_OBSERVED'),
    ]
    const remedied = sources.map(error => remediateFsError(error, 'x'))
    expect(remedied.map(error => error.message)).toEqual([
      'cannot modify "x": file has not been read — read the file, then retry',
      'cannot modify "x": file has not been read — read the file, then retry',
    ])
    expect(remedied.map(error => error.code)).toEqual(['FS_NOT_OBSERVED', 'FS_NOT_OBSERVED'])
    expect(remedied.map(error => error.cause)).toEqual(sources)
  })

  it('preserves the provider diagnostic and adds the recovery hint to FS_EDIT_NOT_FOUND', () => {
    const original = new FsError('no match anywhere. Read with offset=2, limit=1.', 'FS_EDIT_NOT_FOUND')
    const remedied = remediateFsError(original, 'x')
    expect(remedied.message).toContain(original.message)
    expect(remedied.message).toContain('do not repeat the same edit')
    expect(remedied.code).toBe('FS_EDIT_NOT_FOUND')
    expect(remedied.cause).toBe(original)
  })

  it('leaves other FsError codes untouched', () => {
    const original = new FsError('multiple matches', 'FS_AMBIGUOUS_EDIT')
    expect(remediateFsError(original, 'x')).toBe(original)
  })

  it('leaves non-FsError values untouched', () => {
    const original = new Error('boom')
    expect(remediateFsError(original, 'x')).toBe(original)
  })
})
