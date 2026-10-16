import { registerAs } from '@nestjs/config'
import { getEnv } from './env.schema'

export const databaseConfig = registerAs('database', () => ({
  url: getEnv().DATABASE_URL,
}))
