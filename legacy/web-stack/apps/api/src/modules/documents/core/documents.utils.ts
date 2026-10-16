import {
  DOCUMENT_VISIBILITY,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import { Prisma } from '@prisma/client'

export const documentSelect = {
  id: true,
  workspaceId: true,
  createdBy: true,
  visibility: true,
  parentId: true,
  title: true,
  currentProjectionId: true,
  currentProjectionRevision: true,
  latestVersionSnapshotId: true,
  summary: true,
  status: true,
  order: true,
  createdAt: true,
  updatedAt: true,
  trashedAt: true,
} satisfies Prisma.DocumentSelect

export type PersistedDocument = Prisma.DocumentGetPayload<{
  select: typeof documentSelect
}>

/** 工作区文档树上下文 */
export interface WorkspaceDocumentContext {
  documents: PersistedDocument[]
  documentsById: Map<string, PersistedDocument>
  childrenByParent: Map<string | null, PersistedDocument[]>
}

export function buildWorkspaceDocumentContext(documents: PersistedDocument[]): WorkspaceDocumentContext {
  const documentsById = new Map(documents.map(document => [document.id, document]))
  const childrenByParent = new Map<string | null, PersistedDocument[]>()

  for (const document of documents) {
    const siblings = childrenByParent.get(document.parentId) ?? []
    siblings.push(document)
    childrenByParent.set(document.parentId, siblings)
  }

  return {
    documents,
    documentsById,
    childrenByParent,
  }
}

export function collectAncestorTitles(
  document: PersistedDocument,
  context: WorkspaceDocumentContext,
) {
  const ancestorTitles: string[] = []
  let currentDocument = document.parentId
    ? context.documentsById.get(document.parentId)
    : undefined

  while (currentDocument) {
    ancestorTitles.push(currentDocument.title)
    currentDocument = currentDocument.parentId
      ? context.documentsById.get(currentDocument.parentId)
      : undefined
  }

  return ancestorTitles.reverse()
}

export function collectDescendantDocumentIds(
  rootId: string,
  context: WorkspaceDocumentContext,
  documentIds: Set<string>,
) {
  if (documentIds.has(rootId)) {
    return
  }

  documentIds.add(rootId)

  for (const child of context.childrenByParent.get(rootId) ?? []) {
    collectDescendantDocumentIds(child.id, context, documentIds)
  }
}

export function canUserAccessWorkspaceDocument(input: {
  userId: string
  workspaceType: string | undefined
  visibility: string
  createdBy: string
}) {
  if (input.workspaceType !== WORKSPACE_TYPE.TEAM) {
    return true
  }

  if (input.visibility === DOCUMENT_VISIBILITY.WORKSPACE) {
    return true
  }

  return input.createdBy === input.userId
}
