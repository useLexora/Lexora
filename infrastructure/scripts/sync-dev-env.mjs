#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const source = parseEnv(await readFile(resolve(root, 'infrastructure/.env'), 'utf8'))
if (!source.DATABASE_URL || !source.PUBLIC_ORIGIN)
  throw new Error('Configure the community using infrastructure/.env.dev.example before starting development')
const database = new URL(source.DATABASE_URL)
if (database.pathname !== '/lexora_community_dev' || !['127.0.0.1', 'localhost'].includes(database.hostname))
  throw new Error('Development requires a local lexora_community_dev database')
const keys = ['DATABASE_URL', 'PUBLIC_ORIGIN', 'LEXORA_ADMIN_IDENTITIES', 'OAUTH_PROXY_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'LINUX_DO_CLIENT_ID', 'LINUX_DO_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
const contents = keys.filter(key => source[key]).map(key => `${key}=${JSON.stringify(source[key])}`).join('\n')
await writeFile(resolve(root, 'apps/api/.env'), `${contents}\n`, { mode: 0o600 })
console.log('Generated community API environment')
