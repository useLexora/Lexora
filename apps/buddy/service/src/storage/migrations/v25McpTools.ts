export const BUDDY_V25_MCP_TOOLS_SCHEMA_SQL = `
ALTER TABLE mcp_servers ADD COLUMN tool_namespace TEXT;
ALTER TABLE mcp_servers ADD COLUMN tool_exposure TEXT NOT NULL DEFAULT 'deferred'
  CHECK (tool_exposure IN ('deferred', 'direct', 'codemode', 'hidden'));
CREATE UNIQUE INDEX idx_mcp_tool_namespace ON mcp_servers(tool_namespace);
`
