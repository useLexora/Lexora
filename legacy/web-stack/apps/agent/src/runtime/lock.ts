import { randomUUID } from 'node:crypto'

export interface AgentRuntimeTryLock {
  tryRunExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T | null>
}

export function createMemoryAgentRuntimeTryLock(): AgentRuntimeTryLock {
  const activeKeys = new Set<string>()

  return {
    async tryRunExclusive(key, task) {
      if (activeKeys.has(key)) {
        return null
      }

      activeKeys.add(key)
      try {
        return await task()
      }
      finally {
        activeKeys.delete(key)
      }
    },
  }
}

export function createAgentRuntimeTryLockToken(): string {
  return randomUUID()
}
