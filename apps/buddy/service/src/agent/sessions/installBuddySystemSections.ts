import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import { supportsModelToolCalls } from '../../providers/modelCapabilities'
import { BUDDY_SYSTEM_SECTION_NAMES, buildBuddySystemSections } from '../context/buddySystemSections'

export function installBuddySystemSections(session: AgentSession, getInputMessages?: () => AgentSession['messages']): void {
  const prepare = session.agent.prepareNextTurnWithContext
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const prepared = await prepare?.(turn, signal)
    const context = prepared?.context ?? turn.context
    const current = getCurrentSystemMessage(context.messages)?.sections ?? {}
    const active = new Set(session.getActiveToolNames())
    const sections = buildBuddySystemSections([...context.messages, ...getInputMessages?.() ?? []], session.model && supportsModelToolCalls(session.model) ? session.getAllTools().filter(tool => active.has(tool.name)) : [])
    const changes: Record<string, string | null> = {}
    for (const name of BUDDY_SYSTEM_SECTION_NAMES) {
      const value = sections[name] ? `<${name}>\n${sections[name]}\n</${name}>` : null
      if ((current[name] ?? null) !== value)
        changes[name] = value
    }
    const messages = (prepared?.messages ?? []).flatMap((message) => {
      if (message.role !== 'system' || !message.sections)
        return [message]
      const sections = { ...message.sections }
      for (const name of BUDDY_SYSTEM_SECTION_NAMES)
        delete sections[name]
      if (!Object.keys(sections).length && !message.content && !message.toolsAdded?.length && !message.toolsRemoved?.length)
        return []
      return [{ ...message, sections }]
    })
    if (Object.keys(changes).length)
      messages.push({ role: 'system', content: '', sections: changes, timestamp: Date.now() })
    return { ...prepared, context, messages }
  }
}
