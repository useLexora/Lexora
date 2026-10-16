import Redis from 'ioredis'

export type RedisCommandArgument = string | number
export type RedisStreamMessage = [string, string[]]
export type RedisStreamReadResult = Array<[string, RedisStreamMessage[]]>

/** agent Redis client 最小能力。 */
export interface AgentRedisClient {
  del: (key: string) => Promise<number>
  eval: (...args: RedisCommandArgument[]) => Promise<unknown>
  get: (key: string) => Promise<string | null>
  set: (...args: RedisCommandArgument[]) => Promise<'OK' | null>
  xgroup: (...args: RedisCommandArgument[]) => Promise<unknown>
  xreadgroup: (...args: RedisCommandArgument[]) => Promise<RedisStreamReadResult | null>
  xack: (streamName: string, groupName: string, messageId: string) => Promise<number>
  xadd: (...args: RedisCommandArgument[]) => Promise<string>
  quit: () => Promise<unknown>
}

export function createAgentRedisClient(redisUrl: string): AgentRedisClient {
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  }) as unknown as AgentRedisClient
}
