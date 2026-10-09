import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyCapability } from '../../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../../agent/extensions/BuddyInProcessExtension'
import type { BuddyMcpTools } from './McpConnectorService'
import { createToolClassificationFailure } from '../../approvals/toolClassification'
import { readToolDetails } from '../../events/toolPresentationSupport'
import { classifyMcpTool } from './mcpToolContract'

export function createMcpCapability(mcp: BuddyMcpTools, isCodemodeEnabled: () => boolean = () => true): BuddyCapability {
  const scriptOnly = new Set(mcp.disclosure.filter(policy => policy.exposure === 'codemode').flatMap(policy => policy.tools.map(tool => tool.name)))
  const available = (name: string) => mcp.available(name) && (!scriptOnly.has(name) || isCodemodeEnabled())
  return {
    resourceRevisions: mcp.resourceRevisions,
    extension: createMcpExtension({ tools: mcp.tools, available }),
    classify: (event) => {
      const classification = classifyMcpTool(mcp.classifications, event)
      if (!classification)
        return null
      const validate = () => available(event.toolName) ? null : createToolClassificationFailure('MCP_CONNECTOR_DISABLED')
      return validate() ?? { ...classification, validateBeforeExecution: async () => validate() }
    },
    workspaceMutationTools: mcp.tools.map(tool => tool.name),
    disclosure: mcp.disclosure.map(policy => ({ ...policy, available: (_context, name) => available(name) })),
  }
}

export interface CreateMcpExtensionOptions {
  tools: readonly ToolDefinition[]
  available?: (name: string) => boolean
}

export function createMcpExtension(
  options: CreateMcpExtensionOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-mcp',
    factory(pi) {
      const registered = new Map<string, ToolDefinition['exposure']>()
      function sync() {
        for (const tool of options.tools) {
          const exposure = (options.available?.(tool.name) ?? true) ? tool.exposure : 'hidden'
          if (!registered.has(tool.name) || registered.get(tool.name) !== exposure) {
            pi.registerTool({ ...tool, exposure })
            registered.set(tool.name, exposure)
          }
        }
      }
      sync()
      pi.on('before_agent_start', sync)
      pi.on('context_with_system', sync)
      pi.on('turn_end', sync)
      pi.on('tool_result', (event) => {
        if (event.toolName.startsWith('mcp__') && readToolDetails({ details: event.details })?.isError === true)
          return { isError: true }
      })
    },
  }
}
