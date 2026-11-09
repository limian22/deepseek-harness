/**
 * Controlled stdio MCP server for the recorded MCP discovery-and-call
 * scenario. It lives under this package so Node resolves
 * `@modelcontextprotocol/server`, `@modelcontextprotocol/server/stdio`, and
 * `zod` through mcp-client's declared devDependencies. The snapshot scenario's
 * local `server.mjs` imports this module instead of duplicating the body.
 *
 * Tools: `echo` returns the supplied text unchanged; `denied` throws so a
 * fixture policy can demonstrate an original-name denial without remote work.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const server = new McpServer({ name: 'discovery-snapshot', version: '1' })

server.registerTool('echo', {
  description: 'Echo the supplied text without changing it.',
  inputSchema: z.object({ text: z.string() }),
}, async ({ text }) => ({ content: [{ type: 'text', text }] }))

server.registerTool('denied', {
  description: 'A tool whose execution must be denied by the fixture policy.',
  inputSchema: z.object({}),
}, async () => { throw new Error('Denied tool body must not run') })

await serveStdio(() => server)
