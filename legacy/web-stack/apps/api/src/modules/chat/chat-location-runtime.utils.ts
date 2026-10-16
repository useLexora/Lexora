import type {
  AgentRuntimeHints,
} from '@haohaoxue/lexora-contracts'
import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'
import {
  AGENT_LOCATION_SKILL_KEY,
  AgentRuntimeHintsSchema,
} from '@haohaoxue/lexora-contracts'

export function readTrustedClientIp(input: {
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
  remoteAddress?: string | null
  trustCloudflareHeaders?: boolean
}): string | null {
  if (!input.trustCloudflareHeaders) {
    return readPublicIp(input.remoteAddress)
  }

  return readFirstPublicIp(readHeaderValues(input.headers, 'cf-connecting-ip'))
    ?? readPublicIp(input.remoteAddress)
}

export function createRuntimeHintsWithLocationClientIp(input: {
  runtimeHints?: AgentRuntimeHints | null
  clientIp: string | null
}): AgentRuntimeHints {
  const runtimeHints = AgentRuntimeHintsSchema.parse(input.runtimeHints ?? {})
  const {
    [AGENT_LOCATION_SKILL_KEY]: _clientLocationInput,
    ...skillInputs
  } = runtimeHints.skillInputs

  return AgentRuntimeHintsSchema.parse({
    ...runtimeHints,
    skillInputs: {
      ...skillInputs,
      ...(input.clientIp
        ? {
            [AGENT_LOCATION_SKILL_KEY]: {
              clientIp: input.clientIp,
            },
          }
        : {}),
    },
  })
}

function readHeaderValues(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string,
): string[] {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) {
    return value.flatMap(item => splitCommaSeparatedHeader(item))
  }

  return typeof value === 'string' ? splitCommaSeparatedHeader(value) : []
}

function splitCommaSeparatedHeader(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function readFirstPublicIp(values: string[]): string | null {
  for (const value of values) {
    const ip = readPublicIp(value)
    if (ip) {
      return ip
    }
  }

  return null
}

function readPublicIp(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = normalizeIp(value)
  if (!normalized || !isPublicIp(normalized)) {
    return null
  }

  return normalized
}

function normalizeIp(value: string): string | null {
  const trimmed = value.trim()
  const withoutIpv6Prefix = trimmed.startsWith('::ffff:')
    ? trimmed.slice('::ffff:'.length)
    : trimmed

  return isIP(withoutIpv6Prefix) ? withoutIpv6Prefix : null
}

function isPublicIp(value: string): boolean {
  const kind = isIP(value)
  if (kind === 4) {
    return isPublicIpv4(value)
  }

  if (kind === 6) {
    return isPublicIpv6(value)
  }

  return false
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  const [first, second] = parts

  if (first === undefined || second === undefined) {
    return false
  }

  return !(
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224
  )
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.toLowerCase()

  return normalized !== '::1'
    && !normalized.startsWith('fc')
    && !normalized.startsWith('fd')
    && !normalized.startsWith('fe80:')
}
