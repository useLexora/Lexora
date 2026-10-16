#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const GENERATED_HEADER = '# Generated from infrastructure/.env. Do not edit directly.'
const REQUIRED_ENV_ORDER = [
  'DATABASE_URL',
  'REDIS_URL',
  'APP_SECRET',
  'SYSTEM_ADMIN',
  'API_INTERNAL_URL',
  'APP_INTERNAL_KEY',
  'STORAGE_ENDPOINT',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'AGENT_CHECKPOINTER_DATABASE_URL',
]

const APP_ENV_SPECS = [
  {
    path: 'apps/api/.env',
    entries: [
      ['DATABASE_URL', source => source.DATABASE_URL],
      ['REDIS_URL', source => source.REDIS_URL],
      ['APP_SECRET', source => source.APP_SECRET],
      ['SYSTEM_ADMIN', source => source.SYSTEM_ADMIN],
      ['APP_INTERNAL_KEY', source => source.APP_INTERNAL_KEY],
      ['OAUTH_PROXY_URL', source => source.OAUTH_PROXY_URL],
      ['GITHUB_CLIENT_ID', source => source.GITHUB_CLIENT_ID],
      ['GITHUB_CLIENT_SECRET', source => source.GITHUB_CLIENT_SECRET],
      ['LINUX_DO_CLIENT_ID', source => source.LINUX_DO_CLIENT_ID],
      ['LINUX_DO_CLIENT_SECRET', source => source.LINUX_DO_CLIENT_SECRET],
      ['GOOGLE_CLIENT_ID', source => source.GOOGLE_CLIENT_ID],
      ['GOOGLE_CLIENT_SECRET', source => source.GOOGLE_CLIENT_SECRET],
      ['LEXORA_TRUST_CLOUDFLARE_IP_HEADERS', source => source.LEXORA_TRUST_CLOUDFLARE_IP_HEADERS],
      ['STORAGE_ENDPOINT', source => source.STORAGE_ENDPOINT],
      ['STORAGE_ACCESS_KEY', source => source.STORAGE_ACCESS_KEY],
      ['STORAGE_SECRET_KEY', source => source.STORAGE_SECRET_KEY],
    ],
    required: [
      'DATABASE_URL',
      'REDIS_URL',
      'APP_SECRET',
      'SYSTEM_ADMIN',
      'APP_INTERNAL_KEY',
      'STORAGE_ENDPOINT',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
    ],
  },
  {
    path: 'apps/agent/.env',
    entries: [
      ['API_INTERNAL_URL', source => source.API_INTERNAL_URL],
      ['REDIS_URL', source => source.REDIS_URL],
      ['AGENT_CHECKPOINTER_DATABASE_URL', source => readFirst(source, [
        'AGENT_CHECKPOINTER_DATABASE_URL',
        'DATABASE_URL',
      ])],
      ['AGENT_CHECKPOINT_RETENTION_DAYS', source => source.AGENT_CHECKPOINT_RETENTION_DAYS],
      ['AGENT_MAX_CONCURRENT_RUNS', source => source.AGENT_MAX_CONCURRENT_RUNS],
      ['APP_INTERNAL_KEY', source => source.APP_INTERNAL_KEY],
    ],
    required: [
      'API_INTERNAL_URL',
      'REDIS_URL',
      'AGENT_CHECKPOINTER_DATABASE_URL',
      'APP_INTERNAL_KEY',
    ],
  },
]

export function parseEnvText(text) {
  const result = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    const normalizedLine = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separatorIndex = normalizedLine.indexOf('=')

    if (separatorIndex <= 0) {
      continue
    }

    const key = normalizedLine.slice(0, separatorIndex).trim()
    const value = normalizedLine.slice(separatorIndex + 1).trim()

    if (key) {
      result[key] = unquoteEnvValue(value)
    }
  }

  return result
}

export function buildAppEnvFiles(source) {
  const files = {}
  const missing = []

  for (const spec of APP_ENV_SPECS) {
    const values = new Map()

    for (const [name, resolveValue] of spec.entries) {
      values.set(name, normalizeEnvValue(resolveValue(source)))
    }

    for (const name of spec.required) {
      if (!values.get(name)) {
        missing.push(name)
      }
    }

    files[spec.path] = stringifyEnvEntries(values)
  }

  if (missing.length > 0) {
    throw new Error(`Missing required infrastructure env values: ${sortMissingEnvNames(missing).join(', ')}`)
  }

  return files
}

export async function syncDevEnv(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const envPath = options.envPath ?? resolve(repoRoot, 'infrastructure/.env')

  if (!existsSync(envPath)) {
    throw new Error('Missing infrastructure/.env. Run: cp infrastructure/.env.dev.example infrastructure/.env')
  }

  const source = parseEnvText(await readFile(envPath, 'utf8'))
  const files = buildAppEnvFiles(source)

  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const targetPath = resolve(repoRoot, relativePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }))

  return Object.keys(files)
}

function stringifyEnvEntries(values) {
  const lines = [GENERATED_HEADER]

  for (const [name, value] of values) {
    if (value === undefined) {
      continue
    }

    lines.push(`${name}=${formatEnvValue(value)}`)
  }

  return `${lines.join('\n')}\n`
}

function readFirst(source, names) {
  for (const name of names) {
    const value = normalizeEnvValue(source[name])

    if (value) {
      return value
    }
  }

  return undefined
}

function normalizeEnvValue(value) {
  if (value === undefined || value === null) {
    return undefined
  }

  const normalized = String(value).trim()
  return normalized.length > 0 ? normalized : undefined
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1)
  }

  return value
}

function formatEnvValue(value) {
  if (/^[^\s#'"]*$/.test(value)) {
    return value
  }

  return JSON.stringify(value)
}

function dedupe(values) {
  return Array.from(new Set(values))
}

function sortMissingEnvNames(values) {
  const order = new Map(REQUIRED_ENV_ORDER.map((name, index) => [name, index]))

  return dedupe(values).sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER

    return leftOrder - rightOrder || left.localeCompare(right)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncDevEnv()
    .then((files) => {
      for (const file of files) {
        console.log(`Generated ${file}`)
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
