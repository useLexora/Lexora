import type { ApprovalReuseScope } from '../../../shared/permissions/approvalReviewPayload'
import type { ApprovalRequest } from './ApprovalService'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { APPROVAL_REUSE_SCOPES } from '../../../shared/permissions/approvalReviewPayload'

export interface ApprovalAuthorizationKeys {
  operation: string
  source?: string
}

export interface ApprovalAuthorizationOverride {
  operation: readonly unknown[]
  source?: readonly unknown[]
}

export function approvalReuseScopes(keys: ApprovalAuthorizationKeys, scopes: readonly ApprovalReuseScope[] = APPROVAL_REUSE_SCOPES): readonly ApprovalReuseScope[] {
  return APPROVAL_REUSE_SCOPES.filter(scope => scopes.includes(scope) && (scope !== 'source' || keys.source !== undefined))
}

export function createApprovalAuthorizationKeys(input: ApprovalRequest, override = input.reuse): ApprovalAuthorizationKeys {
  if (override)
    return keys([input.kind, ...override.operation], override.source && [input.kind, ...override.source])

  if (input.networkPermission) {
    const target = ['network', input.networkPermission.host, input.networkPermission.port, input.networkPermission.operation]
    return keys([...target, input.arguments], target)
  }
  if (input.network) {
    const target = ['sandbox-network', input.network.host.toLowerCase().replace(/\.$/, ''), input.network.port]
    return keys([...target, input.cwd, command(input)], target)
  }
  if (input.sandboxDirectory)
    return keys(['sandbox-directory', input.sandboxDirectory.path, input.sandboxDirectory.access])

  if (input.kind === 'shell') {
    const source = ['shell', input.toolName, input.shell?.boundary ?? 'host', input.shell?.cwd ?? input.cwd]
    return keys([...source, command(input)], source)
  }
  if (input.paths?.targets.length) {
    const paths = input.paths.targets.map(target => resolve(input.cwd ?? '', target.path)).sort()
    const source = input.paths.targets.some(target => target.zone === 'sensitive')
      ? undefined
      : ['paths', input.paths.access, input.paths.grant?.root ?? [...new Set(paths.map(path => dirname(path)))].sort()]
    return keys(['paths', input.toolName, input.paths.access, paths], source)
  }
  if (input.browser) {
    const review = input.browser
    const source = ['browser', review.sessionId, review.origin]
    return keys([...source, review.pageId, review.documentRevision, review.actionDigest], source)
  }
  if (input.systemAction) {
    const target = readRecord(input.arguments).target
    const source = ['system', target, input.systemAction.target]
    return keys([...source, input.systemAction.action], source)
  }
  if (input.automation) {
    const args = readRecord(input.arguments)
    const id = args.automationId ?? readRecord(args.draft).id
    return keys(['automation', args], typeof id === 'string' ? ['automation', id] : undefined)
  }
  if (input.kind === 'network') {
    const args = readRecord(input.arguments)
    const provider = args.provider ?? 'auto'
    if (input.toolName === 'lexora_web_search')
      return keys(['search', provider, args.query], ['search', provider])
    if (typeof args.url === 'string') {
      try {
        const url = new URL(args.url)
        url.hash = ''
        return keys(['network', input.toolName, provider, url.href], ['network', input.toolName, provider, url.origin])
      }
      catch {}
    }
  }
  return keys([input.kind, input.toolName, input.arguments])
}

function keys(operation: readonly unknown[], source?: readonly unknown[]): ApprovalAuthorizationKeys {
  return { operation: digest(operation), ...(source ? { source: digest(source) } : {}) }
}

function digest(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return entry
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
  })).digest('hex')
}

function command(input: ApprovalRequest): string {
  const value = readRecord(input.arguments).command
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
