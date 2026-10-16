export interface McpToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Readonly<Record<string, unknown>>
    required?: readonly string[]
    [key: string]: unknown
  }
}

export interface McpToolCallResult {
  content?: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [key: string]: unknown
}

export type McpToolConcurrencyMode = 'parallel' | 'serial'

export interface McpToolClient {
  listTools: () => Promise<readonly McpToolDefinition[]>
  callTool: (input: {
    name: string
    arguments?: Record<string, unknown>
  }) => Promise<McpToolCallResult>
  close?: () => Promise<void>
}
