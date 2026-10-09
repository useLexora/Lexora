import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CallToolResult, Progress } from '@modelcontextprotocol/client'
import type { TSchema } from 'typebox'
import type { McpToolExposure } from '../../../../shared/connectors/mcpToolExposure'
import type { BuddyToolDisclosurePolicy } from '../../agent/extensions/discovery/toolDiscoveryContract'
import type { BuddyToolClassification } from '../../approvals/toolClassification'
import type { McpCatalogTool } from './mcpEvents'
import type { McpResultWriter } from './mcpToolResults'
import { createHash } from 'node:crypto'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { mcpErrorCode } from './mcpErrors'
import { McpToolNames } from './mcpToolNames'
import { normalizeMcpResult } from './mcpToolResults'

export interface CreateMcpToolsOptions {
  serverId: string
  serverName: string
  namespace?: string
  exposure?: McpToolExposure
  generation: number
  callTool: (tool: McpCatalogTool, arguments_: unknown, signal?: AbortSignal, onProgress?: (progress: Progress) => void) => Promise<CallToolResult>
  tools: readonly McpCatalogTool[]
  toolNames?: ReadonlyMap<string, string>
  writeResult?: McpResultWriter
}

export interface McpToolsResult {
  disclosure: BuddyToolDisclosurePolicy
  classifications: Map<string, BuddyToolClassification>
  diagnostics: Array<{ code: 'MCP_TOOL_INVALID', message: string }>
  tools: ToolDefinition[]
}

export interface McpToolDetails {
  code?: string
  connector: string
  connectorTool: string
  artifactIds: string[]
  isError?: boolean
  progress?: number
  total?: number
}

export function createMcpTools(options: CreateMcpToolsOptions): McpToolsResult {
  const classifications = new Map<string, BuddyToolClassification>()
  const diagnostics: McpToolsResult['diagnostics'] = []
  const tools: ToolDefinition[] = []
  const disclosure: BuddyToolDisclosurePolicy = {
    source: { kind: 'mcp', id: options.serverId, title: options.serverName },
    exposure: options.exposure === 'deferred' || !options.exposure ? 'on_demand' : options.exposure,
    keywords: 'mcp connector connected service 连接器 已连接 服务',
    tools: [],
  }
  const metadata: { name: string, id: string, title: string, aliases: string[] }[] = []
  const namespace = options.namespace ?? options.serverId.replaceAll(/\W/g, '_').slice(0, 32)
  const assignedNames = options.toolNames ?? new McpToolNames().assign([{ serverId: options.serverId, namespace, toolNames: options.tools.map(tool => tool.name) }]).get(options.serverId)!
  const names = new Set<string>()
  for (const sourceTool of options.tools) {
    const remoteTool = copyEventSnapshot(sourceTool)
    const name = assignedNames.get(remoteTool.name)!
    if (names.has(name)) {
      diagnostics.push({ code: 'MCP_TOOL_INVALID', message: 'MCP tool names conflict' })
      continue
    }
    names.add(name)
    metadata.push({ name, id: remoteTool.name, title: remoteTool.title ?? remoteTool.name, aliases: [createLegacyMcpToolName(options.serverId, remoteTool.name)] })
    tools.push(defineTool<TSchema, McpToolDetails>({
      name,
      label: `${options.serverName} · ${remoteTool.title ?? remoteTool.name}`,
      description: `${options.serverName}: ${remoteTool.description ?? remoteTool.name}`.slice(0, 2048),
      parameters: structuredClone(remoteTool.inputSchema) as TSchema,
      outputSchema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: { type: 'object' } },
          ...(remoteTool.outputSchema ? { structuredContent: structuredClone(remoteTool.outputSchema) } : {}),
          isError: { type: 'boolean' },
          _meta: { type: 'object' },
        },
        required: ['content'],
      },
      exposure: options.exposure === 'direct' || options.exposure === 'hidden' ? options.exposure : 'deferred',
      namespace: { name: namespace, description: options.serverName },
      execute: async (_toolCallId, parameters, signal, onUpdate, context) => {
        const details: McpToolDetails = { connector: options.serverName, connectorTool: remoteTool.name, artifactIds: [] }
        let lastProgress = 0
        try {
          signal?.throwIfAborted()
          onUpdate?.({ content: [{ type: 'text', text: 'MCP tool is running' }], details })
          const result = await options.callTool(remoteTool, parameters, signal, (progress) => {
            if (!onUpdate || signal?.aborted || Date.now() - lastProgress < 250)
              return
            lastProgress = Date.now()
            onUpdate({ content: [{ type: 'text', text: progress.message?.slice(0, 512) ?? 'MCP tool is running' }], details: { ...details, progress: progress.progress, total: progress.total } })
          })
          signal?.throwIfAborted()
          const normalized = await normalizeMcpResult(result, options.writeResult, signal, context.model?.input.includes('image') ?? false)
          return { content: normalized.content, structuredContent: normalized.structuredContent, details: { ...details, artifactIds: normalized.artifactIds, isError: normalized.isError }, isError: normalized.isError }
        }
        catch (error) {
          signal?.throwIfAborted()
          const code = mcpErrorCode(error, 'MCP_TOOL_FAILED')
          return { content: [{ type: 'text', text: `MCP tool failed: ${code}` }], details: { ...details, code, isError: true }, isError: true }
        }
      },
    }))
    classifications.set(name, classifyTool(options, remoteTool))
  }
  return { classifications, diagnostics, tools, disclosure: { ...disclosure, tools: metadata } }
}

export function createLegacyMcpToolName(serverId: string, toolName: string): string {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)
  const readable = toolName.replaceAll(/\W/g, '_').slice(0, 27) || 'tool'
  return `mcp__${hash(serverId)}__${readable}_${hash(toolName)}`
}

function classifyTool(options: Pick<CreateMcpToolsOptions, 'generation' | 'serverId' | 'serverName'>, tool: McpCatalogTool): BuddyToolClassification {
  return {
    access: 'network',
    approval: {
      kind: 'mcp',
      reuse: {
        operation: [options.serverId, options.generation, tool.name],
        source: [options.serverId, options.generation],
      },
      summary: `${options.serverName}: ${tool.title ?? tool.name}`,
    },
    requireApproval: true,
  }
}
