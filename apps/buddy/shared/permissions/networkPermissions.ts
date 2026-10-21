import { z } from 'zod'
import { compileNetworkRegex } from './safeNetworkRegex'

export const NETWORK_OPERATIONS = ['access', 'download', 'upload'] as const
export const NETWORK_PERMISSION_DECISIONS = ['ask', 'allow', 'deny'] as const
export type NetworkOperation = typeof NETWORK_OPERATIONS[number]
export type NetworkPermissionDecision = typeof NETWORK_PERMISSION_DECISIONS[number]

const decisionSchema = z.enum(NETWORK_PERMISSION_DECISIONS)
const decisionsSchema = z.object({
  access: decisionSchema,
  download: decisionSchema,
  upload: decisionSchema,
}).strict()

export function normalizeNetworkHost(value: string): string | null {
  const input = value.trim()
  if (!input || input.length > 1024 || /[\s/\\?#@%]/.test(input))
    return null
  const ipv6 = input.startsWith('[') && input.endsWith(']')
  if (!ipv6 && /[:[\]]/.test(input))
    return null
  try {
    const url = new URL(`http://${input}`)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (host.length > 253 || url.port || !host)
      return null
    if (ipv6)
      return host
    if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
      return null
    return host
  }
  catch {
    return null
  }
}

export const networkPermissionRuleSchema = decisionsSchema.extend({
  id: z.string().trim().min(1).max(128),
  pattern: z.string().trim().min(1).max(256),
  match: z.enum(['exact', 'subdomains', 'regex']),
}).superRefine((rule, context) => {
  if (rule.match === 'regex') {
    if (!compileNetworkRegex(rule.pattern))
      context.addIssue({ code: 'custom', path: ['pattern'], message: 'invalid_regex' })
  }
  else if (!normalizeNetworkHost(rule.pattern)) {
    context.addIssue({ code: 'custom', path: ['pattern'], message: 'invalid_host' })
  }
}).transform(rule => ({
  ...rule,
  pattern: rule.match === 'regex' ? rule.pattern : normalizeNetworkHost(rule.pattern)!,
}))

export const networkPermissionsSchema = z.object({
  defaults: decisionsSchema,
  rules: z.array(networkPermissionRuleSchema).max(100),
}).strict().superRefine((settings, context) => {
  const ids = new Set<string>()
  const patterns = new Set<string>()
  settings.rules.forEach((rule, index) => {
    if (ids.has(rule.id))
      context.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: 'duplicate_id' })
    const key = `${rule.match}:${rule.pattern}`
    if (patterns.has(key))
      context.addIssue({ code: 'custom', path: ['rules', index, 'pattern'], message: 'duplicate_pattern' })
    ids.add(rule.id)
    patterns.add(key)
  })
})

export type NetworkPermissions = z.infer<typeof networkPermissionsSchema>
export type NetworkPermissionRule = NetworkPermissions['rules'][number]

export const DEFAULT_NETWORK_PERMISSIONS: NetworkPermissions = {
  defaults: { access: 'ask', download: 'ask', upload: 'ask' },
  rules: [],
}

export function findNetworkPermissionRule(settings: NetworkPermissions, host: string): NetworkPermissionRule | undefined {
  const normalized = normalizeNetworkHost(host)
  if (!normalized)
    return undefined
  let suffix: NetworkPermissionRule | undefined
  let suffixLength = 0
  let regex: NetworkPermissionRule | undefined
  for (const rule of settings.rules) {
    if (rule.match === 'regex') {
      if (!regex && compileNetworkRegex(rule.pattern)?.(normalized))
        regex = rule
      continue
    }
    const pattern = normalizeNetworkHost(rule.pattern)
    if (!pattern)
      continue
    if (rule.match === 'exact' && pattern === normalized)
      return rule
    if (rule.match === 'subdomains'
      && (pattern === normalized || normalized.endsWith(`.${pattern}`))
      && pattern.length > suffixLength) {
      suffix = rule
      suffixLength = pattern.length
    }
  }
  return suffix ?? regex
}

export function upsertNetworkPermission(
  settings: NetworkPermissions,
  host: string,
  operation: NetworkOperation,
  decision: NetworkPermissionDecision = 'allow',
): NetworkPermissions {
  const normalized = normalizeNetworkHost(host)
  if (!normalized)
    throw new Error('invalid_host')
  const exact = settings.rules.find(rule => rule.match === 'exact' && normalizeNetworkHost(rule.pattern) === normalized)
  const rule: NetworkPermissionRule = {
    id: exact?.id ?? crypto.randomUUID(),
    pattern: normalized,
    match: 'exact',
    access: resolveNetworkPermission(settings, normalized, 'access'),
    download: resolveNetworkPermission(settings, normalized, 'download'),
    upload: resolveNetworkPermission(settings, normalized, 'upload'),
    [operation]: decision,
  }
  return networkPermissionsSchema.parse({
    defaults: settings.defaults,
    rules: exact ? settings.rules.map(item => item.id === exact.id ? rule : item) : [...settings.rules, rule],
  })
}

export function resolveNetworkPermission(
  settings: NetworkPermissions,
  host: string,
  operation: NetworkOperation,
): NetworkPermissionDecision {
  if (!normalizeNetworkHost(host))
    return 'deny'
  return findNetworkPermissionRule(settings, host)?.[operation] ?? settings.defaults[operation]
}
