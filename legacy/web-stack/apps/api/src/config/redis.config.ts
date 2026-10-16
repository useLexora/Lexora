import { registerAs } from '@nestjs/config'
import { getEnv } from './env.schema'

/** Redis 运行配置。 */
export interface RedisConfig {
  url: string
}

export const redisConfig = registerAs('redis', (): RedisConfig => ({
  url: getEnv().REDIS_URL,
}))
