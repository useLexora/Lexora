import type { ResourceRef } from '@/workbench/common/workbench'

export interface TaskResource extends ResourceRef {
  readonly scheme: 'task'
  readonly data: ResourceRef['data'] & { readonly branchId?: string }
}

export interface DraftResource extends ResourceRef {
  readonly scheme: 'draft'
  readonly data: ResourceRef['data'] & { readonly spaceId: string | null }
}

export type TaskWorkspaceResource = TaskResource | DraftResource

export function taskResource(id: string, branchId?: string | null): TaskResource {
  return { scheme: 'task', id, data: typeof branchId === 'string' ? { branchId } : {} }
}

export function draftResource(id: string, spaceId: string | null = null): DraftResource {
  return { scheme: 'draft', id, data: { spaceId } }
}

export function parseTaskResource(resource: ResourceRef): TaskWorkspaceResource | null {
  if (resource.scheme === 'task') {
    const { branchId, ...data } = resource.data
    const target = taskResource(resource.id, typeof branchId === 'string' ? branchId : undefined)
    return { ...target, data: { ...data, ...target.data } }
  }
  if (resource.scheme === 'draft')
    return { ...draftResource(resource.id), data: { ...resource.data, spaceId: typeof resource.data.spaceId === 'string' ? resource.data.spaceId : null } }
  return null
}

export function isLegacyDraftResource(resource: TaskWorkspaceResource): boolean {
  return resource.scheme === 'draft' && (resource.id === 'global' || resource.id === resource.data.spaceId)
}
