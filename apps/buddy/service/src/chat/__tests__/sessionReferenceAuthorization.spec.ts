import type { ConversationRecord } from '../../storage/conversationRecord'
import { describe, expect, it } from 'vitest'
import { resolveAuthorizedSessionReferences } from '../sessionReferenceAuthorization'

function conversation(id: string, spaceId: string | null, title: string | null = 'Session'): ConversationRecord {
  return {
    buddyId: 'default',
    id,
    spaceId,
    title,
    deletedAt: null,
    activeBranchId: 'branch',
    approvalPolicy: 'policy',
    createdAt: '2026-01-01T00:00:00.000Z',
    executionProfile: 'read_only',
    modelSelection: null,
    origin: 'interactive',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('session reference authorization', () => {
  it('allows global and cross-space references using stored titles instead of clipboard titles', () => {
    const findById = (id: string) => conversation(id, id === 'global' ? null : 'space-b', 'Real\nTitle')
    expect(resolveAuthorizedSessionReferences([
      { id: 'global', title: 'Forged title' },
      { id: 'scoped', title: 'Forged title' },
    ], { findById })).toEqual([{ id: 'global', title: 'Real Title' }, { id: 'scoped', title: 'Real Title' }])
  })

  it('rejects deleted or missing sessions and silently deduplicates references', () => {
    const findById = (id: string) => id === 'missing' ? null : { ...conversation(id, null), deletedAt: id === 'deleted' ? '2026-01-01T00:00:00.000Z' : null }
    expect(resolveAuthorizedSessionReferences([
      { id: 'ok', title: 'Old title' },
      { id: 'ok', title: 'Duplicate' },
    ], { findById })).toEqual([{ id: 'ok', title: 'Session' }])
    expect(() => resolveAuthorizedSessionReferences([{ id: 'deleted', title: 'Session' }], { findById }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() => resolveAuthorizedSessionReferences([{ id: 'missing', title: 'Session' }], { findById }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
  })
})
