/**
 * On-demand MCP tool discovery: validated budgets, compact helper tools, and
 * original-identity invocation through the shared guarded pipeline.
 *
 * A server configured with `exposure: 'discovery'` keeps every original tool
 * registered (so scoped restrictions, step admission, guards, approval, and
 * timeouts still see its original public name) but withholds their schemas
 * from model declarations. Three compact helpers replace them:
 *
 * - `mcp_discover__<server>` searches the current generation's tools and
 *   returns bounded name/description entries with paging.
 * - `mcp_describe__<server>` returns one exact tool's description and full
 *   JSON Schema, within the schema byte budget.
 * - `mcp_call__<server>` dispatches one original tool by its original public
 *   name through a per-fiber `ToolExecutionPipeline`, so policy, approval,
 *   guards, timeout, cancellation, post-execution policy, and durable nested
 *   records behave exactly as a direct call.
 *
 * Helper names live outside the `mcp__<server>__<raw>` namespace: an MCP
 * server may publish a raw tool named `call_tool` or `discover_tools`, and
 * those must keep their normal public names.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendSubDispatch, appendSubDispatchStart, defineTool, ToolNotFoundError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionResult, ToolsService } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Images forwarded from one on-demand MCP call into the enclosing model request. */
    'mcp-mode': { kind: 'mcp-mode' }
  }
}

/** How one server's tools are presented to the model. */
export type McpToolExposure = 'direct' | 'discovery'

/** Bounded budgets for one server's discovery helpers. */
export interface DiscoveryConfig {
  /** Maximum tool entries in one discovery page (default 25). */
  maxResults?: number
  /** Maximum UTF-8 bytes of one compact search entry, description included (default 2048). */
  maxResultBytes?: number
  /** Maximum UTF-8 bytes of one full tool schema returned by describe (default 8192). */
  maxSchemaBytes?: number
  /** Maximum UTF-8 bytes of one complete discovery or describe response (default 32768). */
  maxResponseBytes?: number
}

/** Defaults shared by the Config schema and {@link resolveDiscoveryPolicy}. */
export const DISCOVERY_DEFAULTS: Readonly<Required<DiscoveryConfig>> = Object.freeze({
  maxResults: 25,
  maxResultBytes: 2_048,
  maxSchemaBytes: 8_192,
  maxResponseBytes: 32_768,
})

/** Fully resolved discovery budgets captured at plugin load. */
export type ResolvedDiscoveryPolicy = Readonly<Required<DiscoveryConfig>>

/** Discovery configuration section schema, shared with `dsh-mcp-manager`. */
export const DiscoverySchema: z<DiscoveryConfig> = z.object({
  maxResults: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DISCOVERY_DEFAULTS.maxResults),
  maxResultBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DISCOVERY_DEFAULTS.maxResultBytes),
  maxSchemaBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DISCOVERY_DEFAULTS.maxSchemaBytes),
  maxResponseBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DISCOVERY_DEFAULTS.maxResponseBytes),
})

/** Validated exposure selection and discovery budgets for one server. */
export interface ResolvedExposurePolicy {
  /** Selected model presentation. */
  readonly exposure: McpToolExposure
  /** Resolved discovery budgets; unused in direct mode. */
  readonly discovery: ResolvedDiscoveryPolicy
}

/** Registration inputs for the three discovery helpers. */
export interface DiscoveryBridgeOptions {
  /** Stable server namespace used in helper names and diagnostics. */
  readonly serverName: string
  /** The exact originals this connection generation registered, keyed by public name. */
  readonly definitions: ReadonlyMap<string, ToolDefinition>
  /** Validated result budgets. */
  readonly policy: ResolvedDiscoveryPolicy
  /** Per-fiber guarded invocation pipeline that dispatches originals by their original name. */
  readonly pipeline: ToolExecutionPipeline
}

/** One compact search entry returned to the model. */
interface CompactEntry {
  readonly name: string
  readonly description: string
  readonly descriptionBytes: number
  readonly truncated: boolean
}

/** One compact search entry's canonical value. */
interface DiscoverOutput {
  readonly query: string
  readonly total: number
  readonly offset: number
  readonly results: CompactEntry[]
  readonly omitted: number
}

/** One exact tool description's canonical value. */
interface DescribeOutput {
  readonly name: string
  readonly description: string
  readonly parameters: JsonValue
  readonly parametersBytes: number
}

/** One on-demand invocation's canonical value; text-only, images travel as context. */
interface CallOutput {
  readonly name: string
  readonly content: { readonly type: 'text'; readonly text: string }[]
}

/** UTF-8 byte length, the unit of every discovery budget. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** UTF-8 byte length of one lossless JSON value. */
function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

/**
 * Validate one externally supplied value as lossless JSON.
 * @param value - candidate value from a typed but unvalidated source.
 * @param label - subject named in the failure.
 * @returns the same value typed as lossless JSON.
 */
function asJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) throw new Error(`${label} is not lossless JSON`)
  return value as JsonValue
}

/**
 * Model-facing helper names for one server. They never occupy the
 * `mcp__<server>__<raw>` namespace, so a remote tool may publish a raw name
 * such as `call_tool` without losing its original public name.
 * @param serverName - stable server namespace.
 * @returns the three helper names for that server.
 */
export function discoveryToolNames(serverName: string): { discover: string; describe: string; call: string } {
  return {
    discover: `mcp_discover__${serverName}`,
    describe: `mcp_describe__${serverName}`,
    call: `mcp_call__${serverName}`,
  }
}

/**
 * Resolve exposure and discovery budgets, re-judging every default and bound
 * so programmatic construction that bypassed Schemastery still fails at load.
 * Raw non-string exposure values are rejected by the Config schema; this
 * resolve step validates the string a typed caller could still pass.
 * @param config - raw exposure selection (validated string) and optional discovery budgets.
 * @param path - diagnostic prefix naming the config location.
 * @returns the frozen resolved policy.
 */
export function resolveExposurePolicy(
  config: { exposure?: string; discovery?: DiscoveryConfig },
  path: string,
): ResolvedExposurePolicy {
  const exposure = config.exposure ?? 'direct'
  if (exposure !== 'direct' && exposure !== 'discovery') {
    throw new Error(`${path}.exposure must be "direct" or "discovery"`)
  }
  const raw = config.discovery
  if (raw !== undefined) {
    for (const key of Object.keys(raw)) {
      if (!Object.hasOwn(DISCOVERY_DEFAULTS, key)) throw new Error(`${path}.discovery.${key} is not a discovery option`)
    }
  }
  const resolve = (key: keyof Required<DiscoveryConfig>): number => {
    const value = raw?.[key] ?? DISCOVERY_DEFAULTS[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${path}.discovery.${key} must be a positive integer`)
    }
    return value
  }
  return Object.freeze({
    exposure,
    discovery: Object.freeze({
      maxResults: resolve('maxResults'),
      maxResultBytes: resolve('maxResultBytes'),
      maxSchemaBytes: resolve('maxSchemaBytes'),
      maxResponseBytes: resolve('maxResponseBytes'),
    }),
  })
}

/** Deterministic, case-insensitive match over public names and descriptions. */
function searchTools(definitions: ReadonlyMap<string, ToolDefinition>, query: string): ToolDefinition[] {
  const needle = query.toLowerCase()
  return [...definitions.values()]
    .filter(definition => needle.length === 0
      || definition.name.toLowerCase().includes(needle)
      || definition.description.toLowerCase().includes(needle))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/**
 * The caller-visible originals of this connection generation, derived once per
 * request. Ownership is identity: a catalog row participates only when the
 * caller's admitted set (or the live registry view outside a step) resolves the
 * exact definition this generation registered. Restrictions, expired step
 * admissions, replaced generations, and same-name scoped shadows therefore
 * never surface or route another registration.
 * @param tools - retained registry providing the step-less view outside a step.
 * @param exec - the helper invocation supplying the caller and step admission.
 * @param definitions - the originals this generation registered.
 * @returns admitted originals keyed by public name.
 */
function admittedOriginals(
  tools: ToolsService,
  exec: Pick<ToolExecutionInput, 'agent' | 'toolSet'>,
  definitions: ReadonlyMap<string, ToolDefinition>,
): ReadonlyMap<string, ToolDefinition> {
  const visible = new Map<string, ToolDefinition>()
  const admitted = exec.toolSet?.view(exec.agent)
  for (const definition of definitions.values()) {
    const current = admitted === undefined ? tools.get(definition.name, exec.agent) : admitted.get(definition.name)
    if (current === definition) visible.set(definition.name, definition)
  }
  return visible
}

/** Explicit marker for a description that cannot fit one entry's byte budget. */
function truncationMarker(omittedBytes: number): string {
  return ` [truncated: ${String(omittedBytes)} UTF-8 bytes omitted]`
}

/**
 * Bound one compact entry to its byte budget, truncating the description at a
 * code-point boundary and recording the exact omitted byte count.
 * @param entry - entry with the complete description.
 * @param maxBytes - maximum UTF-8 bytes of the serialized entry.
 * @returns the entry as-is, or a truncated copy with an explicit marker.
 */
function boundEntry(entry: CompactEntry, maxBytes: number): CompactEntry {
  if (jsonBytes(entry) <= maxBytes) return entry
  const codePoints = Array.from(entry.description)
  const candidate = (count: number): CompactEntry => {
    const kept = codePoints.slice(0, count).join('')
    const omittedBytes = entry.descriptionBytes - utf8Bytes(kept)
    return { ...entry, description: kept + truncationMarker(omittedBytes), truncated: true }
  }
  let low = 0
  let high = codePoints.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(candidate(mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  if (jsonBytes(candidate(low)) <= maxBytes) return candidate(low)
  throw new Error(`discovery.maxResultBytes (${String(maxBytes)}) is too small for one tool entry; raise discovery.maxResultBytes`)
}

/** Complete emitted size of one projection: its serialized content structure in UTF-8. */
function contentBytes(content: readonly ContentBlock[]): number {
  return jsonBytes(content)
}

/** Render one discovery response exactly as the model receives it. */
function renderDiscover(serverName: string, value: DiscoverOutput): ContentBlock[] {
  const header = value.query.length > 0
    ? `MCP tools on "${serverName}" matching "${value.query}"`
    : `MCP tools on "${serverName}"`
  if (value.results.length === 0) {
    const missing = value.total === 0
      ? 'no tools match'
      : value.offset >= value.total
        ? `offset ${String(value.offset)} is past the ${String(value.total)} matches`
        : 'the configured response budget cannot return any match'
    return [{ type: 'text', text: `${header}: ${missing}.` }]
  }
  const first = value.offset + 1
  const last = value.offset + value.results.length
  const lines = value.results.map(entry => entry.description.length > 0 ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`)
  const more = value.omitted > 0
    ? ` ${String(value.omitted)} more; call again with offset=${String(last)}.`
    : ''
  return [{ type: 'text', text: `${header} (showing ${String(first)}-${String(last)} of ${String(value.total)}):\n${lines.join('\n')}${more}` }]
}

/** Render one exact tool description exactly as the model receives it. */
function renderDescribe(serverName: string, value: DescribeOutput): ContentBlock[] {
  const description = value.description.length > 0 ? value.description : '(no description)'
  return [{
    type: 'text',
    text: `Tool ${value.name} on "${serverName}":\n${description}\nParameters (JSON Schema):\n${JSON.stringify(value.parameters, null, 2)}`,
  }]
}

/**
 * Fit one discovery response into its complete-response budget, counting both
 * the canonical JSON value and the rendered model content, and dropping tail
 * entries into the explicit omitted count rather than silently truncating.
 * When matches remain but no single entry fits, this fails with a config hint
 * instead of reporting an empty page as "past the matches".
 * @param serverName - server namespace used by the renderer.
 * @param value - complete response value with the requested page.
 * @param maxBytes - maximum UTF-8 bytes of the complete emitted response.
 * @returns the response with the largest prefix of results that fits.
 */
function fitDiscover(serverName: string, value: DiscoverOutput, maxBytes: number): DiscoverOutput {
  const results = [...value.results]
  const build = (): DiscoverOutput => ({
    ...value,
    results,
    omitted: Math.max(0, value.total - value.offset - results.length),
  })
  const overBudget = (candidate: DiscoverOutput): boolean =>
    jsonBytes(candidate) > maxBytes || contentBytes(renderDiscover(serverName, candidate)) > maxBytes
  while (results.length > 0 && overBudget(build())) results.pop()
  const bounded = build()
  if (overBudget(bounded)) {
    throw new Error(`discovery.maxResponseBytes (${String(maxBytes)}) is too small for one discovery response; raise discovery.maxResponseBytes`)
  }
  if (bounded.total > bounded.offset && bounded.results.length === 0) {
    throw new Error(`discovery.maxResponseBytes (${String(maxBytes)}) is too small to return one discovery entry; raise discovery.maxResponseBytes or discovery.maxResultBytes`)
  }
  return bounded
}

/** Project authoritative post-policy content to text blocks, naming non-text blocks explicitly. */
function textProjection(name: string, content: readonly ContentBlock[]): CallOutput['content'] {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push(`[${block.type} result; forwarded as separate context when available]`)
  }
  const text = parts.join('\n')
  return [{ type: 'text', text: text.length > 0 ? text : `(${name} returned no model-visible content)` }]
}

/**
 * Text form of one authoritative failure content projection. Derives the
 * wrapper's failure message from the settled content — never from
 * `result.error.message`, which can still carry detail a finalizer already
 * replaced.
 */
function failureText(content: readonly ContentBlock[]): string {
  const text = content.map(block => block.type === 'text' ? block.text : `[${block.type} content]`).join('\n')
  return text.length > 0 ? text : 'the MCP tool call failed'
}

/** Captured nested failure content, installed before the outer post-execute policy runs. */
type CallFailures = WeakMap<ToolExecution, ContentBlock[]>

/**
 * Build the three discovery helpers for one connection generation.
 * @param ctx - plugin context providing the tool registry and logger.
 * @param options - server namespace, exact generation originals, budgets, and pipeline.
 * @returns helper definitions keyed by model-facing name.
 */
export function createDiscoveryTools(ctx: Context, options: DiscoveryBridgeOptions): Map<string, ToolDefinition> {
  const { serverName, definitions, policy, pipeline } = options
  const names = discoveryToolNames(serverName)
  const tools = new Map<string, ToolDefinition>()
  /** Registry retained for lookups and durable log shaping while the context can be inactive. */
  const registry = ctx.tools
  /** Nested failure content awaiting the wrapper's pre-policy content projection. */
  const callFailures: CallFailures = new WeakMap()

  tools.set(names.discover, defineTool({
    name: names.discover,
    description: `Search the tools published by MCP server "${serverName}". Returns compact names and descriptions with paging; use ${names.describe} for one tool's full parameter schema and ${names.call} to invoke it.`,
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring of a tool name or description; omit to list every tool.' },
      offset: { type: 'integer', description: 'Number of matching tools to skip (default 0).' },
      limit: { type: 'integer', description: `Maximum entries to return (default and maximum ${String(policy.maxResults)}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          offset: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                descriptionBytes: { type: 'integer', required: true },
                truncated: { type: 'boolean', required: true },
              },
            },
          },
          omitted: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return renderDiscover(serverName, value)
      },
    },
    execute(args, exec) {
      const query = args.query ?? ''
      const offset = Math.max(0, args.offset ?? 0)
      const limit = Math.min(Math.max(1, args.limit ?? policy.maxResults), policy.maxResults)
      const matches = searchTools(admittedOriginals(registry, exec, definitions), query)
      const page = matches.slice(offset, offset + limit)
      const entries = page.map(definition => boundEntry({
        name: definition.name,
        description: definition.description,
        descriptionBytes: utf8Bytes(definition.description),
        truncated: false,
      }, policy.maxResultBytes))
      return Promise.resolve(fitDiscover(serverName, {
        query,
        total: matches.length,
        offset,
        results: entries,
        omitted: Math.max(0, matches.length - offset - entries.length),
      }, policy.maxResponseBytes))
    },
  }))

  tools.set(names.describe, defineTool({
    name: names.describe,
    description: `Describe one tool published by MCP server "${serverName}", including its complete JSON Schema parameters.`,
    parameters: {
      name: { type: 'string', required: true, description: `Exact tool name from ${names.discover}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
          parameters: { type: 'json', required: true },
          parametersBytes: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return renderDescribe(serverName, value)
      },
    },
    execute(args, exec) {
      const definition = admittedOriginals(registry, exec, definitions).get(args.name)
      if (definition === undefined) {
        throw new ToolNotFoundError(args.name, definitions.has(args.name)
          ? 'the tool is not admitted for this step; it may be restricted, removed, or from a previous connection generation'
          : `server "${serverName}" does not publish it; use ${names.discover} to list the available tools`)
      }
      const parameters = asJsonValue(definition.parameters, `MCP tool "${args.name}" parameters`)
      const parametersBytes = jsonBytes(parameters)
      if (parametersBytes > policy.maxSchemaBytes) {
        throw new Error(`the schema for "${args.name}" is ${String(parametersBytes)} bytes, exceeding discovery.maxSchemaBytes (${String(policy.maxSchemaBytes)}); raise discovery.maxSchemaBytes or inspect the server directly`)
      }
      const value: DescribeOutput = {
        name: definition.name,
        description: definition.description,
        parameters,
        parametersBytes,
      }
      if (jsonBytes(value) > policy.maxResponseBytes || contentBytes(renderDescribe(serverName, value)) > policy.maxResponseBytes) {
        throw new Error(`the description of "${args.name}" exceeds discovery.maxResponseBytes (${String(policy.maxResponseBytes)}) once rendered; raise discovery.maxResponseBytes`)
      }
      return Promise.resolve(value)
    },
  }))

  tools.set(names.call, defineTool({
    name: names.call,
    description: `Invoke one tool published by MCP server "${serverName}" under its original tool name, with the server's normal permissions, approvals, and timeouts.`,
    parameters: {
      name: { type: 'string', required: true, description: `Exact tool name from ${names.discover}.` },
      arguments: {
        type: 'object',
        additionalProperties: true,
        description: 'Arguments object for the tool, matching its JSON Schema parameters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          content: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true, const: 'text' },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        return value.content.map(block => ({ type: 'text', text: block.text }))
      },
    },
    projectContent(exec, result) {
      const content = callFailures.get(exec)
      callFailures.delete(exec)
      // The nested call already applied its own finalizers and post policy;
      // install that authoritative content BEFORE the outer policy runs, so an
      // outer block or replacement still wins.
      return content === undefined || !result.isError ? undefined : content
    },
    async execute(args, exec): Promise<CallOutput> {
      const name = args.name
      const definition = admittedOriginals(registry, exec, definitions).get(name)
      if (definition === undefined) {
        throw new ToolNotFoundError(name, definitions.has(name)
          ? 'the tool is not admitted for this step; it may be restricted, removed, or from a previous connection generation'
          : `server "${serverName}" does not publish it; use ${names.discover} to list the current tools`)
      }
      const callArguments = args.arguments ?? {}
      const subCallId = ToolCallId(`${String(exec.callId)}:mcp:1`)
      appendSubDispatchStart(exec.agent, {
        rootCallId: exec.rootCallId,
        parentCallId: exec.callId,
        subCallId,
        name,
        arguments: callArguments,
      })
      const input: ToolExecutionInput = {
        callId: subCallId,
        rootCallId: exec.rootCallId,
        name,
        arguments: callArguments,
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        ...exec.toolSet === undefined ? {} : { toolSet: exec.toolSet },
        parent: exec.token,
        signal: exec.signal,
      }
      let result: ToolExecutionResult
      try {
        const prepared = await pipeline.prepare(input)
        const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
        result = await pipeline.complete(prepared.exec, outcome)
      } catch (error: unknown) {
        // The pipeline contains tool failures; this preserves start/settlement
        // pairing for any unexpected internal refusal.
        const message = error instanceof Error ? error.message : String(error)
        await appendSubDispatch(ctx, registry, exec.agent, {
          exec,
          subCallId,
          name,
          isError: true,
          content: [{ type: 'text', text: `Error: ${message}` }],
          arguments: callArguments,
        })
        throw error
      }
      await appendSubDispatch(ctx, registry, exec.agent, {
        exec,
        subCallId,
        name,
        isError: result.isError,
        content: result.content,
        arguments: callArguments,
        ...result.error?.info === undefined ? {} : { error: result.error.info },
        ...result.meta === undefined ? {} : { meta: result.meta },
      })
      const images = result.isError ? [] : result.content.filter(block => block.type === 'image')
      if (images.length > 0) {
        exec.deferContext(createUserMessage({ content: images, source: { kind: 'mcp-mode' } }))
      }
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      if (result.concludesTurn) exec.concludeTurn()
      if (result.isError) {
        // The nested pipeline already applied the original tool's finalizers and
        // post policy, so its content is authoritative; `error.message` may still
        // carry detail a finalizer replaced. Derive the wrapper failure from the
        // settled content and preserve the structured identity.
        const message = failureText(result.content)
        callFailures.set(exec, result.content)
        const info = result.error.info
        if (info === undefined) throw new Error(message)
        const failure = new HarnessError(message, info.code)
        failure.name = info.name
        throw failure
      }
      return { name, content: textProjection(name, result.content) }
    },
  }))

  return tools
}
