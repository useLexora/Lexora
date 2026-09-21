import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { buildSessionContext } from '@earendil-works/pi-coding-agent'
import { supportsModelToolCalls } from '../../providers/modelCapabilities'
import { createBuddyInputReferenceMessage } from '../context/BuddyInputReference'
import { buildBuddySystemSections } from '../context/buddySystemSections'

export function createSystemSectionsExtension(getPendingInput?: () => BuddyInputReferenceV1 | null): BuddyInProcessExtension {
  return {
    name: 'lexora-system-sections',
    factory(pi) {
      pi.on('before_agent_start', (event, context) => {
        const messages = buildSessionContext(context.sessionManager.getBranch()).messages
        const pending = getPendingInput?.()
        messages.push(pending
          ? createBuddyInputReferenceMessage(pending, Date.now())
          : { role: 'user', content: [{ type: 'text', text: event.prompt }, ...event.images ?? []], timestamp: Date.now() })
        const active = new Set(pi.getActiveTools())
        Object.assign(event.systemPromptOptions.sections, buildBuddySystemSections(messages, context.model && supportsModelToolCalls(context.model) ? pi.getAllTools().filter(tool => active.has(tool.name)) : []))
      })
    },
  }
}
