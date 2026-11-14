import { describe, expect, it } from 'vitest'
import { resourceKey } from '@/workbench/common/workbench'
import { draftResource, isLegacyDraftResource, parseTaskResource } from '../taskResource'

describe('task resource identity', () => {
  it('normalizes old optional metadata while retaining additional JSON data and resource identity', () => {
    const oldTask = { scheme: 'task', id: 'task', data: { branchId: null, custom: 'kept' } }
    const oldDraft = { scheme: 'draft', id: 'draft', data: { custom: 'kept' } }
    expect(parseTaskResource(oldTask)).toEqual({ scheme: 'task', id: 'task', data: { custom: 'kept' } })
    expect(parseTaskResource(oldDraft)).toEqual({ scheme: 'draft', id: 'draft', data: { spaceId: null, custom: 'kept' } })
    expect(resourceKey(parseTaskResource(oldTask)!)).toBe(resourceKey(oldTask))
    expect(resourceKey(parseTaskResource(oldDraft)!)).toBe(resourceKey(oldDraft))
    expect(isLegacyDraftResource(draftResource('global'))).toBe(true)
    expect(isLegacyDraftResource(draftResource('space', 'space'))).toBe(true)
    expect(isLegacyDraftResource(draftResource('draft', 'space'))).toBe(false)
  })
})
