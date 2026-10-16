import type { AgentIdempotencyStore } from './command'
import type {
  AgentCommandQueue,
  AgentControlHandler,
  AgentEventPublisher,
  AgentRunner,
} from './typing'
import { createAgentCommandWorker } from './command'

export interface CreateAgentRuntimeOptions {
  queue: AgentCommandQueue
  events?: AgentEventPublisher
  runner: AgentRunner
  idempotency?: AgentIdempotencyStore
  onControl?: AgentControlHandler
}

export interface AgentRuntime {
  start: () => Promise<void>
  stop: () => Promise<void>
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const commandWorker = createAgentCommandWorker({
    idempotency: options.idempotency,
    onControl: options.onControl,
    queue: options.queue,
    runner: options.runner,
  })

  return {
    async start() {
      await commandWorker.start()
    },

    async stop() {
      await commandWorker.stop()
      await options.events?.close?.()
    },
  }
}

export * from './command'
export * from './typing'
