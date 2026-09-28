import type { McpCatalogTool } from './mcpEvents'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { McpClientError } from './mcpErrors'

const toolSchema = z.object({
  name: z.string().min(1).max(256),
  title: z.string().max(512).optional(),
  description: z.string().optional(),
  inputSchema: z.object({ type: z.literal('object') }).catchall(z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
})
const catalogSchema = z.array(toolSchema).max(1_024)
const MAX_CATALOG_BYTES = 4 * 1024 * 1024

export function parseMcpCatalog(value: unknown): McpCatalogTool[] {
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success)
    throw new McpClientError('MCP_TOOL_INVALID')
  const names = new Set<string>()
  const tools = parsed.data.map((tool) => {
    if (names.has(tool.name) || Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 64 * 1024)
      throw new McpClientError('MCP_TOOL_INVALID')
    names.add(tool.name)
    return { ...tool, description: tool.description?.slice(0, 2 * 1024) }
  })
  if (Buffer.byteLength(JSON.stringify(tools)) > MAX_CATALOG_BYTES)
    throw new McpClientError('MCP_TOOL_INVALID')
  return tools
}

export function readMcpCatalog(value: string): McpCatalogTool[] {
  if (Buffer.byteLength(value) > MAX_CATALOG_BYTES)
    throw new McpClientError('MCP_TOOL_INVALID')
  return parseMcpCatalog(JSON.parse(value))
}

export function mcpToolFingerprint(tool: McpCatalogTool): string {
  return createHash('sha256').update(JSON.stringify({ name: tool.name, input: tool.inputSchema, output: tool.outputSchema, annotations: tool.annotations })).digest('hex')
}
