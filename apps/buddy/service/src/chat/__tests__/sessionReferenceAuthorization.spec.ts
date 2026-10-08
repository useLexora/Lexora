import type { ConversationRecord } from '../../storage/conversationRecord'
import { describe, expect, it, vi } from 'vitest'
import { resolveAuthorizedSessionReferences } from '../sessionReferenceAuthorization'

function conversation(id: string, spaceId: string | null, title: string | null = 'Session'): ConversationRecord {
  return {
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
  it('allows a global session and replaces its clipboard title with the stored title', () => {
    const findById = vi.fn(() => conversation('global', null, 'Real\nTitle'))
    expect(resolveAuthorizedSessionReferences([{ id: 'global', title: 'Forged title' }], { findById }))
      .toEqual([{ id: 'global', title: 'Real Title' }])
  })

  it('allows a session from a different space', () => {
    const findById = vi.fn(() => conversation('scoped', 'space-b'))
    expect(resolveAuthorizedSessionReferences([{ id: 'scoped', title: 'Session' }], { findById })).toHaveLength(1)
  })

  it('rejects deleted or missing sessions and silently deduplicates references', () => {
    const findById = vi.fn((id: string) => id === 'missing' ? null : { ...conversation(id, null), deletedAt: id === 'deleted' ? '2026-01-01T00:00:00.000Z' : null })
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
