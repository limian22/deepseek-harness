/** Physical Zstd suffixes of already validated current JSONL generations. */
import { createHash } from 'node:crypto'
import { decodeSeqRanges, type SessionEvent } from '@deepseek-ai/dsh-session'
import { decompressZstdFrame, scanZstdFrames } from './zstd.ts'

import type { SessionOpeningSuffix } from '@deepseek-ai/dsh-session-persistence'

export function openingSourceDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Bind an already validated, complete log's opening boundary to its exact compressed bytes. */
export async function describeOpeningSuffix(
  bytes: Buffer,
  firstSeq: number,
  cursor: number,
  signal?: AbortSignal,
): Promise<SessionOpeningSuffix | undefined> {
  signal?.throwIfAborted()
  try {
    const { frames, tornStart } = scanZstdFrames(bytes)
    if (tornStart !== undefined || firstSeq < 0 || firstSeq > cursor) return undefined
    for (let index = frames.length - 1; index > 0; index -= 1) {
      const frame = frames[index]
      if (frame === undefined) return undefined
      const plaintext = await decompressZstdFrame(bytes.subarray(frame.start, frame.end))
      signal?.throwIfAborted()
      const newline = plaintext.indexOf(0x0A)
      if (newline < 0 || plaintext.at(-1) !== 0x0A) return undefined
      const row = JSON.parse(plaintext.toString('utf8', 0, newline)) as { seq?: unknown } | null
      const seq = row?.seq
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
      if (seq > firstSeq) continue
      const previous = frames[index - 1]
      if (previous === undefined) return undefined
      const boundary = await decompressZstdFrame(bytes.subarray(previous.start, previous.end))
      signal?.throwIfAborted()
      if (boundary.at(-1) !== 0x0A) return undefined
      return { digest: openingSourceDigest(bytes), offset: frame.start, firstSeq, cursor }
    }
  } catch {
    signal?.throwIfAborted()
  }
  return undefined
}

/** Decode an exact opening from the same capture that proved the receipt's source digest. */
export async function readOpeningSuffix(
  bytes: Buffer,
  receipt: SessionOpeningSuffix,
  signal?: AbortSignal,
): Promise<SessionEvent[] | undefined> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(receipt.offset) || receipt.offset <= 0 || receipt.offset >= bytes.length
    || !Number.isSafeInteger(receipt.firstSeq) || receipt.firstSeq < 0
    || !Number.isSafeInteger(receipt.cursor) || receipt.cursor < receipt.firstSeq
    || openingSourceDigest(bytes) !== receipt.digest) return undefined
  try {
    const { frames, tornStart } = scanZstdFrames(bytes)
    if (tornStart !== undefined || !frames.some(frame => frame.start === receipt.offset)) return undefined
    const plaintext = await decompressZstdFrame(bytes.subarray(receipt.offset))
    signal?.throwIfAborted()
    if (plaintext.at(-1) !== 0x0A) return undefined
    const events: SessionEvent[] = []
    let start = 0
    let previous: number | undefined
    for (let end = plaintext.indexOf(0x0A); end >= 0; end = plaintext.indexOf(0x0A, start)) {
      signal?.throwIfAborted()
      const event = JSON.parse(plaintext.toString('utf8', start, end)) as SessionEvent
      start = end + 1
      if (!Number.isSafeInteger(event.seq) || event.seq < 0
        || (previous === undefined ? event.seq > receipt.firstSeq : event.seq !== previous + 1)) return undefined
      previous = event.seq
      if (event.seq < receipt.firstSeq) continue
      events.push(event.sourceEventSeqs === undefined ? event
        : { ...event, sourceEventSeqs: decodeSeqRanges(event.sourceEventSeqs, event.seq) })
    }
    return previous === receipt.cursor ? events : undefined
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}
