/** Dependency-free, isolated execution of the actual TypeScript tool entry point.
 * Run with Node >=24.9: node --test packages/boot/plugin-manager/tests/im-self-reload.node.test.mjs
 * This does not exercise real Cordis lifecycle reconciliation or replace Vitest integration tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = stripTypeScriptTypes(readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;?\r?\n/gm, '').replace(/^export /gm, '')
const mutations = ['set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'set_version_exemption']
const reads = ['list_plugins', 'list_bundles', 'list_version_exemptions']
function fixture(id = 'dsh-im-session-fixture', parentSession, agents = new Map(), sessions = new Map()) {
  let tool
  const calls = []
  const manager = new Proxy({}, { get: (_, key) => () => {
    calls.push(String(key))
    return ['listPlugins', 'listBundles'].includes(key) ? [] : { application: 'applied' }
  } })
  const ctx = {
    tools: { register: value => { tool = value } }, pluginManager: manager,
    sandboxPolicy: { resolve: () => { calls.push('policy'); return { mode: 'danger-full-access' } } },
    get: name => ['agents', 'sessions'].includes(name) ? ctx[name] : undefined,
    agents: { get: key => agents.get(key) }, sessions: { get: key => sessions.get(key) },
  }
  const pluginContext = new Proxy(ctx, { get(target, name) {
    if (name === 'agents' || name === 'sessions') throw new Error('optional services must use ctx.get')
    return Reflect.get(target, name)
  } })
  const injection = vm.runInNewContext(source + '\napply(ctx); inject', {
    ctx: pluginContext, defineTool: value => value,
    approveEscalation: async () => { calls.push('approval') },
    assertNever: () => { throw new Error('unexpected action') }, getDshRuntimeVersion: () => 'test',
  })
  const run = action => tool.execute({ action, target: 'example@1.0.0', enabled: true, runtimeVersion: 'test' }, {
    agent: id === null ? undefined : { session: { id, header: { parentSession } } },
    signal: new AbortController().signal, callId: 'fixture',
  })
  return { run, calls, ctx, injection }
}
test('declares only actual required Cordis service names', () => {
  assert.deepEqual(Array.from(fixture().injection), ['tools', 'pluginManager', 'sandboxPolicy'])
})
async function refuses(f, action = 'set_plugin') {
  await assert.rejects(f.run(action), error => error.code === 'im-self-reload-blocked')
  assert.deepEqual(f.calls, [], 'must refuse before policy, approval, or profile manager access')
}
for (const action of mutations) {
  test(`direct IM refuses ${action}`, () => refuses(fixture(), action))
  test(`legacy IM refuses ${action}`, () => refuses(fixture('im:telegram:test'), action))
  test(`descendant refuses ${action} for unrelated target`, () => refuses(fixture('child', 'middle', new Map([
    ['middle', { session: { id: 'middle', header: { parentSession: 'dsh-im-session-owner' } } }],
  ])), action))
}
for (const action of reads) {
  test(`IM preserves permission checks for ${action}`, async () => {
    const f = fixture(); await f.run(action)
    assert.deepEqual(f.calls.slice(0, 2), ['policy', 'approval'])
    assert.equal(f.calls.length, 3)
  })
}
for (const id of ['web-session', null, 'not-dsh-im-session-false-positive']) {
  test(`non-IM caller ${id} retains mutation behavior`, async () => {
    const f = fixture(id); await f.run('set_plugin')
    assert.deepEqual(f.calls, ['policy', 'approval', 'setPluginEnabled'])
  })
}
test('unloaded direct IM parent still refuses without registries', async () => {
  const f = fixture('child', 'dsh-im-session-unloaded')
  delete f.ctx.agents; delete f.ctx.sessions
  await refuses(f)
})
test('session store resolves ancestry when agent is not attached', () => refuses(fixture('child', 'middle', new Map(), new Map([
  ['middle', { id: 'middle', header: { parentSession: 'im:owner' } }],
]))))
test('resolves current registry contents rather than caching ownership', async () => {
  const agents = new Map()
  const f = fixture('child', 'middle', agents)
  await f.run('set_plugin')
  agents.set('middle', { session: { id: 'middle', header: { parentSession: 'im:owner' } } })
  f.calls.length = 0
  await refuses(f)
})
test('missing non-IM ancestor stops without inventing ownership', async () => {
  const f = fixture('child', 'unknown'); await f.run('set_plugin')
  assert.deepEqual(f.calls, ['policy', 'approval', 'setPluginEnabled'])
})
test('cyclic ancestry terminates', async () => {
  const f = fixture('child', 'middle', new Map([
    ['middle', { session: { id: 'middle', header: { parentSession: 'child' } } }],
  ]))
  await f.run('set_plugin')
  assert.deepEqual(f.calls, ['policy', 'approval', 'setPluginEnabled'])
})
test('bounded traversal does not loop on long ancestry', async () => {
  const f = fixture('child', 'node-0')
  let lookups = 0
  f.ctx.agents.get = id => { lookups++; return { session: { id, header: { parentSession: `node-${lookups}` } } } }
  await f.run('set_plugin')
  assert.ok(lookups <= 64)
})
test('ordinary Web call works without optional registry services', async () => {
  const f = fixture('web'); delete f.ctx.agents; delete f.ctx.sessions
  await f.run('set_plugin')
  assert.deepEqual(f.calls, ['policy', 'approval', 'setPluginEnabled'])
})
