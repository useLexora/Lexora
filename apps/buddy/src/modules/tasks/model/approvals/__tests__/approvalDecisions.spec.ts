import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import { describe, expect, it } from 'vitest'
import { projectApprovalDecisions } from '../approvalDecisions'

const now = Date.parse('2026-11-14T00:00:00Z')
function approval(): LocalApproval {
  return {
    id: 'approval',
    runId: 'run',
    toolCallId: 'tool',
    kind: 'shell',
    status: 'pending',
    createdAt: '2026-11-14T00:00:00Z',
    resolvedAt: null,
    summary: 'Run command',
    payload: { card: 'shell', command: 'pwd', toolName: 'bash', allowForTurn: true, reuseScopes: ['operation', 'source', 'turn'] },
    review: { reviewVersion: 'a'.repeat(64), operationDigest: 'b'.repeat(64), contentVersion: 1, body: {}, complete: true, expiresAt: '2026-11-14T00:01:00Z', lifetimeId: 'lifetime', persistentEffect: false, allowedDecisions: ['approved', 'denied', 'approved_for_operation', 'approved_for_turn'] },
  }
}

describe('approval decisions', () => {
  it('intersects presented scopes with the current authoritative review', () => {
    const value = projectApprovalDecisions(approval(), now)
    expect(value.decisions).toEqual(['deny', 'once', 'operation', 'turn'])
    expect(value.reuseScopes).toEqual(['operation', 'turn'])
    expect(value.canPersist).toBe(false)
  })

  it('allows only rejection for incomplete or unsupported content and no decision after expiry', () => {
    const value = approval()
    expect(projectApprovalDecisions({ ...value, review: { ...value.review!, complete: false } }, now).decisions).toEqual(['deny'])
    expect(projectApprovalDecisions({ ...value, payload: { card: 'unknown' } } as unknown as LocalApproval, now).decisions).toEqual(['deny'])
    expect(projectApprovalDecisions(value, now + 60_000).decisions).toEqual([])
    expect(projectApprovalDecisions({ ...value, review: null }, now).decisions).toEqual([])
  })

  it('requires both a persistent grant and an explicitly offered decision', () => {
    const value = approval()
    const paths: LocalApproval = { ...value, kind: 'read', payload: { card: 'paths', toolName: 'read', allowForTurn: false, access: 'read', targets: [{ path: '/workspace', zone: 'outside' }], grant: null, canPersist: true } }
    const offered = { ...paths, review: { ...paths.review!, allowedDecisions: ['approved', 'denied', 'approved_persistently'] as const } }
    expect(projectApprovalDecisions(offered, now).decisions).not.toContain('persistent')
    const granted: LocalApproval = { ...offered, payload: { ...offered.payload, grant: { owner: 'conversation', root: '/workspace' } } as LocalApproval['payload'] }
    expect(projectApprovalDecisions(granted, now).decisions).toContain('persistent')
  })
})
