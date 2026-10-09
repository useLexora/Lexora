export const MCP_TOOL_EXPOSURES = ['deferred', 'direct', 'codemode', 'hidden'] as const
export type McpToolExposure = typeof MCP_TOOL_EXPOSURES[number]

export function mcpNamespaceBase(name: string): string {
  return name.replaceAll(/\W/g, '_').replaceAll(/_+/g, '_').replaceAll(/^_|_$/g, '').slice(0, 32)
}
