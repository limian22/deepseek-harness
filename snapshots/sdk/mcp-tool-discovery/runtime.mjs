/** Assert compact declarations and original-name guarded dispatch in a real SDK turn. */
import assert from 'node:assert/strict'

export const name = 'snapshot-mcp-tool-discovery'
export const inject = ['tools']

const helpers = ['mcp_call__fixture', 'mcp_describe__fixture', 'mcp_discover__fixture']
const originals = ['mcp__fixture__echo', 'mcp__fixture__denied']

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    await agent.ctx.plugin({
      name: 'snapshot-mcp-tool-selection',
      inject: ['tools'],
      apply(inner) {
        inner.tools.restrict({ allow: [...helpers, ...originals] })
        inner.tools.guard(exec => exec.name === 'mcp__fixture__denied'
          ? 'Snapshot policy denied the original MCP tool' : undefined)
      },
    })
  })
  ctx.on('llm/stream', (options, next) => {
    assert.deepEqual(options.tools.map(tool => tool.name).sort(), helpers)
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const starts = events.filter(event => event.type === 'tool/ptc-dispatch-start')
    const results = events.filter(event => event.type === 'tool/ptc-dispatch')
    assert.deepEqual(starts.map(event => event.data.name), originals)
    assert.deepEqual(results.map(event => event.data.name), originals)
    assert.deepEqual(results.map(event => event.data.isError), [false, true])
    assert.equal(results[0].data.content[0].text, 'MCP_DISCOVERY_ECHO')
    assert.match(results[1].data.content[0].text, /Snapshot policy denied/)
    assert.equal(results[0].data.parentCallId, 'mcp-echo')
    assert.equal(results[1].data.parentCallId, 'mcp-denied')
  })
}
