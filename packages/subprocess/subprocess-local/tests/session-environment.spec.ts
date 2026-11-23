import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'

it('applies a registered environment only to the explicit session', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  try {
    vi.stubEnv('AMBIENT_SECRET', 'private')
    vi.stubEnv('MiXeD_Removal', 'ambient')
    const dispose = ctx.subprocess.registerSessionEnvironment(id => id === 'worker' ? { DSH_TEST_OVERLAY: 'ignored', WORKER_VALUE: 'isolated', PATH: 'worker-path', REMOVE_ME: undefined, MIXED_REMOVAL: undefined } : undefined)
    const run = async (env: NodeJS.ProcessEnv) => {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, '-e', 'console.log(JSON.stringify([process.env.WORKER_VALUE, process.env.DSH_TEST_OVERLAY]))'],
        cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } }, graceMs: 200, env,
      })
      await handle.done
      return JSON.parse(handle.collected.stdout!.readFrom(0).text)
    }
    expect(await run({ DSH_SESSION_ID: 'worker', WORKER_VALUE: 'caller' })).toEqual(['isolated', null])
    expect(await run({ DSH_SESSION_ID: 'other' })).toEqual([null, null])
    const envHandle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'console.log(JSON.stringify([process.env.PATH, process.env.REMOVE_ME, process.env.DSH_SESSION_ID, process.env.AMBIENT_SECRET, process.env.MiXeD_Removal]))'],
      cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } }, graceMs: 200,
      env: { DSH_SESSION_ID: 'worker', dsh_session_id: 'spoof', Path: 'caller-path', REMOVE_ME: 'caller' },
    })
    await envHandle.done
    expect(JSON.parse(envHandle.collected.stdout!.readFrom(0).text)).toEqual(['worker-path', null, 'worker', null, process.platform === 'win32' ? null : 'ambient'])
    dispose()
    expect(await run({ DSH_SESSION_ID: 'worker' })).toEqual([null, null])
    const resolver = () => ({ WORKER_VALUE: 'second' })
    const first = ctx.subprocess.registerSessionEnvironment(resolver)
    first()
    const second = ctx.subprocess.registerSessionEnvironment(resolver)
    first()
    expect(await run({ DSH_SESSION_ID: 'worker' })).toEqual(['second', null])
    second()
  } finally {
    vi.unstubAllEnvs()
    await fiber.dispose()
  }
})

it('passes session overrides to terminal allocation', async () => {
  const exits: ((event: { exitCode: number }) => void)[] = []
  const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => ({
    pid: 123, onData: () => ({ dispose() {} }),
    onExit: (listener: (event: { exitCode: number }) => void) => { exits.push(listener); return { dispose() {} } },
    write() {}, kill() {},
  }))
  vi.resetModules()
  vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({ createLazyRequire: () => () => ({ spawn }) }))
  const { default: Runtime } = await import('../src/index.ts')
  const ctx = new Context()
  const fiber = await ctx.plugin(Runtime)
  try {
    const runtime = ctx.subprocess as InstanceType<typeof Runtime>
    runtime.internals = { platform: 'win32' }
    runtime.terminalInspector = {
      foregroundPgid: () => undefined, isStdinWaiting: () => false,
      snapshot: () => ({ tree: () => [], session: () => [], alive: () => false }),
      isAlive: () => false, signalGroup: () => {}, signalProcess: () => {},
    }
    runtime.registerSessionEnvironment(id => id === 'worker' ? { WORKER_VALUE: 'isolated', DSH_SESSION_ID: 'spoof' } : undefined)
    const terminal = await runtime.spawnTerminal({ argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'dumb', graceMs: 1, env: { DSH_SESSION_ID: 'worker', WORKER_VALUE: 'caller' } })
    expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ env: expect.objectContaining({ DSH_SESSION_ID: 'worker', WORKER_VALUE: 'isolated' }) }))
    for (const exit of exits) exit({ exitCode: 0 })
    await terminal.done
  } finally {
    await fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-lazy-require')
    vi.resetModules()
  }
})
