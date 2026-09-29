import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyCapability } from '../../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../../agent/extensions/BuddyInProcessExtension'
import type { BuddyMcpTools } from './McpConnectorService'
import { createToolClassificationFailure } from '../../approvals/toolClassification'
import { readToolDetails } from '../../events/toolPresentationSupport'
import { classifyMcpTool } from './mcpToolContract'

export function createMcpCapability(mcp: BuddyMcpTools): BuddyCapability {
  return {
    resourceRevisions: mcp.resourceRevisions,
    extension: createMcpExtension({ tools: mcp.tools }),
    classify: (event) => {
      const classification = classifyMcpTool(mcp.classifications, event)
      if (!classification)
        return null
      const validate = () => mcp.available(event.toolName) ? null : createToolClassificationFailure('MCP_CONNECTOR_DISABLED')
      return validate() ?? { ...classification, validateBeforeExecution: async () => validate() }
    },
    workspaceMutationTools: mcp.tools.map(tool => tool.name),
    disclosure: mcp.disclosure.map(policy => ({ ...policy, available: (_context, name) => mcp.available(name) })),
  }
}

export interface CreateMcpExtensionOptions {
  tools: readonly ToolDefinition[]
}

export function createMcpExtension(
  options: CreateMcpExtensionOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-mcp',
    factory(pi) {
      for (const tool of options.tools)
        pi.registerTool(tool)
      pi.on('tool_result', (event) => {
        if (event.toolName.startsWith('mcp__') && readToolDetails({ details: event.details })?.isError === true)
          return { isError: true }
      })
    },
  }
}
