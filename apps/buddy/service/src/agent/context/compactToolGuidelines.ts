import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { getCurrentTools } from '@earendil-works/pi-ai'

export function compactToolGuidelines(messages: AgentSession['messages']): AgentSession['messages'] {
  const tools = getCurrentTools(messages.filter(message => message.role === 'system'))
  const description = tools.find(tool => tool.name === 'codemode')?.description
  if (!description)
    return messages

  const inlined = new Set(description.split('\n').filter(line => line.startsWith('- ')))
  return messages.map((message) => {
    if (message.role !== 'system')
      return message
    const section = message.sections?.buddy_tool_guidelines
    if (!section)
      return message
    const compact = section.split('\n').filter(line => !inlined.has(line)).join('\n')
    return compact === section ? message : { ...message, sections: { ...message.sections, buddy_tool_guidelines: compact } }
  })
}
