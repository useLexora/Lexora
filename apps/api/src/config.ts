import process from 'node:process'
import { z } from 'zod'

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    DATABASE_URL: z.string().min(1),
    PUBLIC_ORIGIN: z.url().default('http://localhost:5173'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LEXORA_ADMIN_IDENTITIES: z.string().default(''),
    OAUTH_PROXY_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  }).parse(env)
  const origin = new URL(parsed.PUBLIC_ORIGIN)
  if (origin.origin !== parsed.PUBLIC_ORIGIN || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))))
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed on localhost)')
  return { ...parsed, adminIdentities: new Set(parsed.LEXORA_ADMIN_IDENTITIES.split(',').map(value => value.trim()).filter(Boolean)), secureCookies: origin.protocol === 'https:', env }
}
export type Config = ReturnType<typeof readConfig>
