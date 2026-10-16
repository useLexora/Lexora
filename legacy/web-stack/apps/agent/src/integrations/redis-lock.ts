import type { AgentRuntimeTryLock } from '../runtime/lock'
import type { AgentRedisClient } from './redis-client'
import { createAgentRuntimeTryLockToken } from '../runtime/lock'

const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

export interface CreateRedisAgentRuntimeTryLockOptions {
  redis: AgentRedisClient
  keyPrefix: string
  ttlMs?: number
}

export function createRedisAgentRuntimeTryLock(options: CreateRedisAgentRuntimeTryLockOptions): AgentRuntimeTryLock {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS

  return {
    async tryRunExclusive<T>(key: string, task: () => Promise<T>) {
      const lockKey = `${options.keyPrefix}${key}`
      const token = createAgentRuntimeTryLockToken()
      const acquired = await options.redis.set(lockKey, token, 'PX', ttlMs, 'NX')

      if (acquired !== 'OK') {
        return null
      }

      let taskError: unknown
      let taskResult: T | undefined
      try {
        taskResult = await task()
      }
      catch (error) {
        taskError = error
      }

      try {
        await options.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token)
      }
      catch (error) {
        if (!taskError) {
          throw error
        }
      }

      if (taskError) {
        throw taskError
      }

      return taskResult as T
    },
  }
}
