import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import { supportsModelToolCalls } from '../../providers/modelCapabilities'
import { BUDDY_SYSTEM_SECTION_NAMES, buildBuddySystemSections } from '../context/buddySystemSections'

export function installBuddySystemSections(session: AgentSession, getInputMessages?: () => AgentSession['messages'], getPermissionPrompt?: (activeToolNames: readonly string[]) => string, getActorPrompt?: () => string): void {
  function changesFor(context: { messages: AgentSession['messages'] }) {
    const current = getCurrentSystemMessage(context.messages)?.sections ?? {}
    const active = new Set(session.getActiveToolNames())
    const tools = session.model && supportsModelToolCalls(session.model) ? session.getAllTools().filter(tool => active.has(tool.name)) : []
    const sections = buildBuddySystemSections([...context.messages, ...getInputMessages?.() ?? []], tools)
    const names: readonly string[] = getPermissionPrompt ? [...BUDDY_SYSTEM_SECTION_NAMES, 'buddy_permissions'] : BUDDY_SYSTEM_SECTION_NAMES
    sections.buddy_actor = getActorPrompt?.() ?? ''
    if (getPermissionPrompt)
      sections.buddy_permissions = getPermissionPrompt(tools.map(tool => tool.name))
    const changes: Record<string, string | null> = {}
    for (const name of names) {
      const value = sections[name] ? `<${name}>\n${sections[name]}\n</${name}>` : null
      if ((current[name] ?? null) !== value)
        changes[name] = value
    }
    return changes
  }
  const prepareNextTurn = session.agent.prepareNextTurnWithContext
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const prepared = await prepareNextTurn?.(turn, signal)
    const context = prepared?.context ?? turn.context
    const changes = changesFor(context)
    const names: readonly string[] = getPermissionPrompt ? [...BUDDY_SYSTEM_SECTION_NAMES, 'buddy_permissions'] : BUDDY_SYSTEM_SECTION_NAMES
    const messages = (prepared?.messages ?? []).flatMap((message) => {
      if (message.role !== 'system' || !message.sections)
        return [message]
      const sections = { ...message.sections }
      for (const name of names)
        delete sections[name]
      if (!Object.keys(sections).length && !message.content && !message.toolsAdded?.length && !message.toolsRemoved?.length)
        return []
      return [{ ...message, sections }]
    })
    if (Object.keys(changes).length)
      messages.push({ role: 'system', content: '', sections: changes, timestamp: Date.now() })
    return { ...prepared, context, messages }
  }
  const prepareRequest = session.agent.prepareRequest
  session.agent.prepareRequest = async (request, signal) => {
    const prepared = await prepareRequest?.(request, signal)
    const context = prepared?.context ?? request.context
    const changes = changesFor(context)
    if (!Object.keys(changes).length)
      return prepared ?? undefined
    const message = { role: 'system' as const, content: '', sections: changes, timestamp: Date.now() }
    session.sessionManager.appendMessage(message)
    session.refreshContext()
    return { ...prepared, context: { ...context, messages: [...context.messages, message] } }
  }
}
