import process from 'node:process'
import { optionalNonEmptyString, requiredEnvString } from '@haohaoxue/lexora-shared'
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: requiredEnvString('DATABASE_URL'),
  APP_SECRET: z.string().trim().min(32, 'APP_SECRET 至少需要 32 个字符'),
  APP_INTERNAL_KEY: z.string().trim().min(32, 'APP_INTERNAL_KEY 至少需要 32 个字符'),
  REDIS_URL: requiredEnvString('REDIS_URL'),
  OAUTH_PROXY_URL: optionalNonEmptyString(),
  GITHUB_CLIENT_ID: optionalNonEmptyString(),
  GITHUB_CLIENT_SECRET: optionalNonEmptyString(),
  LINUX_DO_CLIENT_ID: optionalNonEmptyString(),
  LINUX_DO_CLIENT_SECRET: optionalNonEmptyString(),
  GOOGLE_CLIENT_ID: optionalNonEmptyString(),
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString(),
  LEXORA_TRUST_CLOUDFLARE_IP_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform(value => value === 'true'),
  STORAGE_ENDPOINT: requiredEnvString('STORAGE_ENDPOINT'),
  STORAGE_ACCESS_KEY: z.string().trim().min(3, 'STORAGE_ACCESS_KEY 至少需要 3 个字符'),
  STORAGE_SECRET_KEY: z.string().trim().min(8, 'STORAGE_SECRET_KEY 至少需要 8 个字符'),
  SYSTEM_ADMIN: z
    .string()
    .trim()
    .toLowerCase()
    .email(),
})

export type AppEnv = z.infer<typeof envSchema>

export function validateEnv(config: Record<string, unknown>): AppEnv {
  return envSchema.parse(config)
}

let cachedEnv: AppEnv | undefined

export function getEnv(): AppEnv {
  cachedEnv ??= envSchema.parse(process.env)
  return cachedEnv
}
