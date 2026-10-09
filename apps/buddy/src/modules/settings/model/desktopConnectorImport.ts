import type { DesktopConnectorSavePlan } from './desktopConnectorForm'
import { connectorsRequestSchemas } from '@buddy-shared/connectors/connectorApi'
import { MCP_TOOL_EXPOSURES } from '@buddy-shared/connectors/mcpToolExposure'
import { z } from 'zod'

const entrySchema = z.object({
  command: z.string().optional(),
  exposure: z.enum(MCP_TOOL_EXPOSURES).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bearerToken: z.string().optional(),
  type: z.enum(['stdio', 'http', 'streamable-http']).optional(),
}).strict()
const importSchema = z.object({ mcpServers: z.record(z.string().min(1).max(128), entrySchema) }).strict()

export function parseConnectorImport(text: string): DesktopConnectorSavePlan[] {
  if (text.length > 1024 * 1024)
    throw new Error('INVALID_IMPORT')
  const entries = Object.entries(importSchema.parse(JSON.parse(text)).mcpServers)
  if (!entries.length || entries.length > 32)
    throw new Error('INVALID_IMPORT')
  return entries.map(([name, entry]) => {
    const common = { id: crypto.randomUUID(), name, enabled: false, toolExposure: entry.exposure ?? 'deferred' }
    if (Boolean(entry.command) === Boolean(entry.url))
      throw new Error('INVALID_IMPORT')
    if (entry.command) {
      if (entry.headers || entry.bearerToken || (entry.type && entry.type !== 'stdio'))
        throw new Error('INVALID_IMPORT')
      return connectorsRequestSchemas.connectorUpsert.parse({
        config: { ...common, transport: 'stdio', command: entry.command, args: entry.args ?? [], cwd: entry.cwd ?? null },
        credential: entry.env ? { mode: 'replace', value: { type: 'stdio', env: entry.env } } : { mode: 'clear' },
      })
    }
    if (entry.env || entry.cwd || entry.args || entry.type === 'stdio')
      throw new Error('INVALID_IMPORT')
    return connectorsRequestSchemas.connectorUpsert.parse({
      config: { ...common, transport: 'streamable-http', url: entry.url },
      credential: entry.headers || entry.bearerToken
        ? { mode: 'replace', value: { type: 'http', ...(entry.headers ? { headers: entry.headers } : {}), ...(entry.bearerToken ? { bearerToken: entry.bearerToken } : {}) } }
        : { mode: 'clear' },
    })
  })
}
