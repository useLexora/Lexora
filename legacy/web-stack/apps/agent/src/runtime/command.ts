import type {
  AgentCommandQueue,
  AgentControlHandler,
  AgentQueueCommand,
  AgentRunner,
} from './typing'
import {
  AGENT_RUNTIME_CONTROL_TYPE,
  AgentGenerationCommandSchema,
} from '@haohaoxue/lexora-contracts'

export interface AgentIdempotencyStore {
  markStarted: (idempotencyKey: string) => boolean | Promise<boolean>
  has: (idempotencyKey: string) => boolean | Promise<boolean>
  clear: (idempotencyKey: string) => void | Promise<void>
}

export interface CreateAgentCommandWorkerOptions {
  queue: AgentCommandQueue
  runner: AgentRunner
  idempotency?: AgentIdempotencyStore
  onControl?: AgentControlHandler
}

export interface AgentCommandWorker {
  start: () => Promise<void>
  stop: () => Promise<void>
}

export function createAgentCommandWorker(options: CreateAgentCommandWorkerOptions): AgentCommandWorker {
  const idempotency = options.idempotency ?? createMemoryAgentIdempotencyStore()
  let unsubscribe: (() => void) | null = null
  let unsubscribeControl: (() => void) | null = null

  return {
    async start() {
      if (unsubscribe) {
        return
      }

      await options.queue.ready?.()
      unsubscribe = options.queue.subscribe(async (rawCommand) => {
        const command = parseAgentQueueCommand(rawCommand)

        if (!await idempotency.markStarted(command.idempotencyKey)) {
          return
        }

        try {
          await options.runner.submit(command)
        }
        catch (error) {
          await idempotency.clear(command.idempotencyKey)
          throw error
        }
      })
      unsubscribeControl = options.queue.subscribeControl?.((control) => {
        if (control.type === AGENT_RUNTIME_CONTROL_TYPE.CANCEL_RUN) {
          const cancelled = options.runner.cancel(control.runId)

          if (!cancelled) {
            return options.onControl?.(control)
          }

          return
        }

        return options.onControl?.(control)
      }) ?? null
    },

    async stop() {
      unsubscribe?.()
      unsubscribe = null
      unsubscribeControl?.()
      unsubscribeControl = null
      await options.queue.close?.()
    },
  }
}

function parseAgentQueueCommand(rawCommand: unknown): AgentQueueCommand {
  return AgentGenerationCommandSchema.parse(rawCommand)
}

function createMemoryAgentIdempotencyStore(): AgentIdempotencyStore {
  const startedKeys = new Set<string>()

  return {
    markStarted(idempotencyKey) {
      if (startedKeys.has(idempotencyKey)) {
        return false
      }

      startedKeys.add(idempotencyKey)
      return true
    },

    has(idempotencyKey) {
      return startedKeys.has(idempotencyKey)
    },

    clear(idempotencyKey) {
      startedKeys.delete(idempotencyKey)
    },
  }
}
