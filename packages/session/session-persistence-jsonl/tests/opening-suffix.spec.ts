import { expect, it } from 'vitest'
import { compressZstdFrame } from '../src/zstd.ts'
import * as suffix from '../src/opening-suffix.ts'

const physicalEvent = (seq: number) => JSON.stringify({ type: 'user/message', seq, time: 1, data: {} }) + '\n'

it('reads the exact opening suffix from individually aligned physical frames', async () => {
  const prefix = await compressZstdFrame('{"header":true}\n')
  const older = await compressZstdFrame(physicalEvent(0) + physicalEvent(1))
  const selected = await compressZstdFrame(physicalEvent(2) + physicalEvent(3))
  const tail = await compressZstdFrame(physicalEvent(4))
  const bytes = Buffer.concat([prefix, older, selected, tail])
  const receipt = await suffix.describeOpeningSuffix(bytes, 3, 4)
  expect(receipt).toMatchObject({ offset: prefix.length + older.length, firstSeq: 3, cursor: 4 })
  expect((await suffix.readOpeningSuffix(bytes, receipt!))?.map(event => event.seq)).toEqual([3, 4])
})

it('preserves absolute cross-frame source references in selected rows', async () => {
  const header = await compressZstdFrame('{"header":true}\n')
  const earlier = await compressZstdFrame(physicalEvent(0) + physicalEvent(1) + physicalEvent(2))
  const row = { type: 'user/message', seq: 3, time: 1, data: {}, sourceEventSeqs: [[0, 2]] }
  const tail = await compressZstdFrame(`${JSON.stringify(row)}\n`)
  const bytes = Buffer.concat([header, earlier, tail])
  const receipt = await suffix.describeOpeningSuffix(bytes, 3, 3)
  expect(await suffix.readOpeningSuffix(bytes, receipt!)).toEqual([{ ...row, sourceEventSeqs: [0, 1, 2] }])
})

it('rejects changed source bytes even when the indexed tail matches', async () => {
  const prefix = await compressZstdFrame('{"header":1}\n')
  const replacement = await compressZstdFrame('{"header":2}\n')
  const tail = await compressZstdFrame(physicalEvent(0) + physicalEvent(1))
  const original = Buffer.concat([prefix, tail])
  const changed = Buffer.concat([replacement, tail])
  expect(original.length).toBe(changed.length)
  const receipt = await suffix.describeOpeningSuffix(original, 1, 1)
  expect(receipt).toBeDefined()
  expect(await suffix.readOpeningSuffix(changed, receipt!)).toBeUndefined()
})

it('does not index a page that would have to start inside a physical row', async () => {
  const header = await compressZstdFrame('{"header":true}\n')
  const first = await compressZstdFrame(physicalEvent(0).slice(0, 10))
  const rest = await compressZstdFrame(physicalEvent(0).slice(10) + physicalEvent(1))
  expect(await suffix.describeOpeningSuffix(Buffer.concat([header, first, rest]), 0, 1)).toBeUndefined()
})
