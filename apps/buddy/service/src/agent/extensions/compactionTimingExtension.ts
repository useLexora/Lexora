import type { BuddyInProcessExtension } from './BuddyInProcessExtension'

export function createCompactionTimingExtension(): BuddyInProcessExtension {
  return {
    name: 'lexora-compaction-timing',
    factory(pi) {
      let completedResponse = false
      pi.on('agent_end', (event) => {
        const last = event.messages.findLast(message => message.role === 'assistant')
        completedResponse = last?.role === 'assistant' && last.stopReason === 'stop'
          && !last.content.some(block => block.type === 'toolCall')
      })
      pi.on('session_before_compact', (event) => {
        if (event.reason === 'threshold' && completedResponse) {
          completedResponse = false
          return { cancel: true }
        }
      })
      pi.on('agent_before_settle', () => {
        completedResponse = false
      })
      pi.on('agent_settled', () => {
        completedResponse = false
      })
    },
  }
}
