import type { AgentSession, ToolInfo } from '@earendil-works/pi-coding-agent'
import { ATTACHMENT_GUIDELINES } from './attachmentGuidelines'
import { readBuddyInputReference } from './BuddyInputReference'

export const BUDDY_SYSTEM_SECTION_NAMES = ['buddy_tool_guidelines', 'buddy_attachment_resources', 'buddy_actor'] as const

export function buildBuddySystemSections(messages: AgentSession['messages'], tools: readonly ToolInfo[]): Record<string, string> {
  const guidelines = [...new Set(tools.flatMap(tool => !tool.name.startsWith('mcp__')
    ? tool.promptGuidelines ?? []
    : []).map(value => value.trim()).filter(Boolean))]
  if (tools.some(tool => tool.name === 'codemode')) {
    guidelines.push(
      'For batched lookups, inspect fulfilled and rejected results, and print a compact result for each query with its source and any error or truncation notice. Keep dependent calls and mutations sequential; do not replay completed mutations after a later failure.',
      'Discover unlisted codemode tools with searchTools or describeNamespace, and use describeTool for their exact inputs and result type. Filter tool results before printing; MCP results include content, structuredContent, and isError. Tools marked invocation: codemode are script-only. Other specialized tools may need lexora_tool_search followed by a new codemode invocation.',
    )
  }
  const hasResources = messages.some((message) => {
    const input = readBuddyInputReference(message)
    if (input && (input.attachmentIds?.length || input.images.length || input.documents?.length))
      return true
    return message.role === 'user' && Array.isArray(message.content)
      && message.content.some(block => block.type === 'image' || (block.type === 'text' && block.text.includes('<attachment_resources>')))
  })
  return {
    buddy_tool_guidelines: guidelines.length ? `Active tool guidelines:\n${guidelines.map(value => `- ${value}`).join('\n')}` : '',
    buddy_attachment_resources: hasResources ? ATTACHMENT_GUIDELINES : '',
  }
}
