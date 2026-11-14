import type { z } from 'zod'
import type { ApprovalReview } from '../../../shared/permissions/conditionalApproval'
import type { ApprovalRequest, ApprovalResolutionDecision } from './ApprovalService'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'
import { approvalReviewSchema } from '../../../shared/permissions/conditionalApproval'
import { canonicalCommandJson } from '../commands/commandIntent'

export { approvalReviewSchema } from '../../../shared/permissions/conditionalApproval'
export type { ApprovalReview } from '../../../shared/permissions/conditionalApproval'

const sensitive = /password|passwd|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key/i
const maximumReviewBytes = 1024 * 1024

export function createApprovalReview(input: ApprovalRequest, approvalId: string, createdAt: string, timeoutMs: number, scopes: readonly string[]): ApprovalReview {
  const operation = JSON.parse(JSON.stringify({
    kind: input.kind,
    toolName: input.toolName,
    arguments: input.arguments,
    cwd: input.cwd,
    paths: input.paths,
    browser: input.browser,
    automation: input.automation,
    shell: input.shell,
    systemAction: input.systemAction,
    network: input.network,
    networkPermission: input.networkPermission,
    sandboxDirectory: input.sandboxDirectory,
    persistentDirectory: input.persistentDirectory,
  }))
  const operationDigest = digest(canonicalCommandJson(operation))
  const operationBytes = Buffer.byteLength(JSON.stringify(operation), 'utf8')
  const complete = operationBytes <= maximumReviewBytes
  const fullBody = complete
    ? JSON.parse(JSON.stringify(operation, (key, value) => sensitive.test(key) ? '[redacted]' : typeof value === 'string' ? redactSensitiveText(value) : value)) as z.infer<ReturnType<typeof z.json>>
    : { reason: 'review_exceeds_inline_limit', bytes: operationBytes }
  const persistentEffect = Boolean(input.persist || input.persistentDirectory || input.paths?.grant)
  const allowedDecisions: ApprovalResolutionDecision[] = ['denied']
  if (complete) {
    allowedDecisions.push('approved', ...scopes.map(scope => `approved_for_${scope}` as ApprovalResolutionDecision))
    if (input.persist)
      allowedDecisions.push('approved_persistently')
  }
  const content = {
    contentVersion: 1 as const,
    operationDigest,
    body: fullBody,
    complete,
    expiresAt: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    lifetimeId: randomUUID(),
    allowedDecisions,
    persistentEffect,
  }
  return approvalReviewSchema.parse({ ...content, reviewVersion: digest(canonicalCommandJson({ approvalId, runId: input.runId, toolCallId: input.toolCallId, ...content })) })
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
