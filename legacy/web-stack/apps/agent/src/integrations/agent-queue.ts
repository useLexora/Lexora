import type { AgentCommandHandler, AgentCommandQueue, AgentQueueCommand } from '../runtime/typing'

export function createMemoryAgentCommandQueue(): AgentCommandQueue {
  const handlers = new Set<AgentCommandHandler>()

  return {
    async publish(command: AgentQueueCommand) {
      await Promise.all(Array.from(handlers, handler => handler(command)))
    },

    subscribe(handler) {
      handlers.add(handler)

      return () => {
        handlers.delete(handler)
      }
    },

    async close() {
      handlers.clear()
    },
  }
}
