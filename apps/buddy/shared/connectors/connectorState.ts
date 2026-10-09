import { z } from 'zod'

export const connectorErrorCodeSchema = z.enum([
  'MCP_AUTHENTICATION_REQUIRED',
  'MCP_AUTHENTICATION_FAILED',
  'MCP_AUTHENTICATION_CANCELLED',
  'MCP_ACCESS_DENIED',
  'MCP_COMMAND_NOT_FOUND',
  'MCP_CONNECTOR_DISABLED',
  'MCP_EXECUTION_CONFIRMATION_REQUIRED',
  'MCP_CONNECTOR_CHANGED',
  'MCP_RECONNECT_LIMIT_REACHED',
  'MCP_REQUEST_TIMEOUT',
  'MCP_SERVER_DISCONNECTED',
  'MCP_SERVER_UNAVAILABLE',
  'MCP_TOOL_CHANGED',
  'MCP_TOOL_FAILED',
  'MCP_TOOL_INVALID',
  'MCP_NAMESPACE_CONFLICT',
  'MCP_NAMESPACE_IMMUTABLE',
  'MCP_RESULT_TOO_LARGE',
  'MCP_RESULT_STORAGE_DENIED',
])

export type ConnectorErrorCode = z.infer<typeof connectorErrorCodeSchema>

export const connectorRuntimeStateSchema = z.object({
  authorization: z.enum(['oauth', 'credentials']).nullable().default(null),
  status: z.enum(['disabled', 'idle', 'connecting', 'ready', 'authenticating', 'needs_auth', 'error']),
  errorCode: connectorErrorCodeSchema.nullable(),
  toolCount: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
}).strict()

export const connectorToolSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
}).strict()

export type ConnectorRuntimeState = z.infer<typeof connectorRuntimeStateSchema>
export type ConnectorToolSummary = z.infer<typeof connectorToolSummarySchema>
