import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/read-worker.cjs']
  .every(path => existsSync(join(packageRoot, path)))

describe.skipIf(!built)('built read worker (plain node)', () => {
  it('decodes a cold current log inside the published worker bundle', async () => {
    const script = `
      import { mkdtemp, readFile, rm } from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { Worker } from 'node:worker_threads'
      import { Context } from '@deepseek-ai/cordis'
      import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
      import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

      const terminate = Worker.prototype.terminate
      let terminations = 0
      Worker.prototype.terminate = function () {
        terminations += 1
        return terminate.call(this)
      }
      const root = await mkdtemp(join(tmpdir(), 'dsh-built-read-worker-'))
      const id = SessionId('built-read-worker')
      const ctx = new Context()
      let report
      try {
        await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', readWorker: true })
        const events = [
          { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
          { type: 'step/start', seq: 1, time: 11, data: { turn: 1, step: 1 } },
          { type: 'step/end', seq: 2, time: 12, data: { turn: 1, step: 1 } },
          { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
        ]
        const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
        await writer.append(events)
        await writer.close()
        const snapshot = await ctx.sessionPersistence.stat(id)
        const path = snapshot.location.path
        const before = await readFile(path)

        const handle = await ctx.sessionPersistence.open(id, 'read')
        let read
        try { read = (await handle.read()).events } finally { await handle.close() }
        const sameThroughProvider = JSON.stringify(read) === JSON.stringify(events)

        const worker = new Worker(join(process.cwd(), 'lib', 'read-worker.cjs'), {
          workerData: { root, compression: 'none' },
        })
        let ready = false
        let response
        const settled = new Promise((resolve, reject) => {
          worker.on('message', (value) => {
            if (value.kind === 'ready') {
              ready = true
              worker.postMessage({ request: 1, id, path, revision: snapshot.revision })
              return
            }
            response = value
            resolve()
          })
          worker.on('error', reject)
          worker.on('exit', (code) => reject(new Error('read worker exited ' + code)))
        })
        try {
          await settled
        } finally {
          if (worker.threadId !== -1) await worker.terminate()
        }

        const unchanged = before.equals(await readFile(path))
        const decoded = response.kind === 'response' && response.response.ok === true
        report = {
          ready, decoded, sameThroughProvider, unchanged,
          eventCount: decoded ? response.response.events.length : -1,
        }
      } finally {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
      console.log(JSON.stringify({ ...report, terminations }))
    `
    const { exitCode, stdout, stderr, timedOut, signal } = await execa(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: packageRoot, env: { NODE_PATH: undefined, NODE_OPTIONS: undefined },
        stdin: 'ignore', timeout: 60_000, killSignal: 'SIGKILL', reject: false,
      },
    )

    expect(timedOut).toBe(false)
    expect(signal).toBeUndefined()
    expect(exitCode, `stderr:\n${stderr}`).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({
      ready: true, decoded: true, sameThroughProvider: true, unchanged: true,
      eventCount: 4, terminations: 2,
    })
  })
})
