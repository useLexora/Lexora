import type {
  DocumentItem,
  DocumentTreeCollectionId,
  DocumentTreeGroup,
  OwnedDocumentCollectionId,
} from '@haohaoxue/lexora-contracts'

export interface DocumentDeletePlan {
  rootDocumentIds: string[]
  affectedDocumentIds: Set<string>
  nextDocumentId: string | null
}

export type DocumentTreeItemIconName
  = | 'document-tree-file'
    | 'document-tree-file-empty'
    | 'document-tree-folder'
    | 'document-tree-folder-open'

export function isOwnedDocumentCollection(collectionId: DocumentTreeCollectionId): collectionId is OwnedDocumentCollectionId {
  return Boolean(collectionId)
}

export function resolveDocumentTreeItemIcon(
  item: Pick<DocumentItem, 'hasChildren' | 'hasContent'>,
  expanded: boolean,
): DocumentTreeItemIconName {
  if (item.hasChildren) {
    return expanded ? 'document-tree-folder-open' : 'document-tree-folder'
  }

  return item.hasContent ? 'document-tree-file' : 'document-tree-file-empty'
}

export function collectDocumentItemIds(items: DocumentItem[]): Set<string> {
  const documentIds = new Set<string>()

  for (const item of items) {
    documentIds.add(item.id)

    for (const childId of collectDocumentItemIds(item.children)) {
      documentIds.add(childId)
    }
  }

  return documentIds
}

export function updateDocumentBranch(
  items: DocumentItem[],
  targetDocumentId: string,
  input: Partial<DocumentItem>,
): DocumentItem[] {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]

    if (item.id === targetDocumentId) {
      const nextItem = applyDocumentItemPatch(item, input)

      if (nextItem === item) {
        return items
      }

      const nextItems = items.slice()
      nextItems[index] = nextItem
      return nextItems
    }

    const nextChildren = updateDocumentBranch(item.children, targetDocumentId, input)

    if (nextChildren !== item.children) {
      const nextItems = items.slice()
      nextItems[index] = {
        ...item,
        children: nextChildren,
      }
      return nextItems
    }
  }

  return items
}

export function findDocumentPath(
  groups: DocumentTreeGroup[],
  targetDocumentId: string,
): {
  collectionId: DocumentTreeCollectionId
  nodes: DocumentItem[]
} | null {
  for (const group of groups) {
    const items = findDocumentItemPath(group.nodes, targetDocumentId)

    if (items) {
      return {
        collectionId: group.id,
        nodes: items,
      }
    }
  }

  return null
}

export function findDocumentItemPath(
  items: DocumentItem[],
  targetDocumentId: string,
): DocumentItem[] | null {
  for (const item of items) {
    if (item.id === targetDocumentId) {
      return [item]
    }

    const nestedItems = findDocumentItemPath(item.children, targetDocumentId)

    if (nestedItems) {
      return [item, ...nestedItems]
    }
  }

  return null
}

export function resolveDocumentDeletePlan(
  groups: DocumentTreeGroup[],
  documentIds: string[],
  currentActiveDocumentId: string | null,
): DocumentDeletePlan | null {
  const rootDocumentIds: string[] = []
  const affectedDocumentIds = new Set<string>()
  const normalizedDocumentIds = [...new Set(documentIds.map(id => id.trim()).filter(Boolean))]
  const selectedDocumentIds = new Set(normalizedDocumentIds)

  for (const documentId of normalizedDocumentIds) {
    const targetPath = findDocumentPath(groups, documentId)
    const targetDocument = targetPath?.nodes.at(-1)

    if (!targetPath || !targetDocument || !isOwnedDocumentCollection(targetPath.collectionId)) {
      continue
    }

    if (targetPath.nodes.slice(0, -1).some(document => selectedDocumentIds.has(document.id))) {
      continue
    }

    rootDocumentIds.push(documentId)

    for (const affectedDocumentId of collectDocumentItemIds([targetDocument])) {
      affectedDocumentIds.add(affectedDocumentId)
    }
  }

  if (!rootDocumentIds.length) {
    return null
  }

  return {
    rootDocumentIds,
    affectedDocumentIds,
    nextDocumentId: resolveNextDocumentIdAfterDeletePlan(
      groups,
      affectedDocumentIds,
      currentActiveDocumentId,
    ),
  }
}

export function countDocumentItems(items: DocumentItem[]): number {
  let total = 0

  for (const item of items) {
    total += 1 + countDocumentItems(item.children)
  }

  return total
}

function resolveNextDocumentIdAfterDeletePlan(
  groups: DocumentTreeGroup[],
  affectedDocumentIds: Set<string>,
  currentActiveDocumentId: string | null,
): string | null {
  if (!currentActiveDocumentId || !affectedDocumentIds.has(currentActiveDocumentId)) {
    return currentActiveDocumentId
  }

  const activePath = findDocumentPath(groups, currentActiveDocumentId)

  if (activePath) {
    for (let index = activePath.nodes.length - 1; index >= 0; index -= 1) {
      const document = activePath.nodes[index]

      if (!affectedDocumentIds.has(document.id)) {
        return document.id
      }
    }
  }

  return findFirstAvailableDocumentId(
    groups.flatMap(group => group.nodes),
    affectedDocumentIds,
  )
}

export function resolvePreferredDocumentId(
  groups: DocumentTreeGroup[],
  preferredDocumentId: string | null,
): string | null {
  if (preferredDocumentId && findDocumentPath(groups, preferredDocumentId)) {
    return preferredDocumentId
  }

  return findFirstAvailableDocumentId(
    groups.flatMap(group => group.nodes),
    new Set<string>(),
  )
}

function findFirstAvailableDocumentId(
  items: DocumentItem[],
  deletedDocumentIds: Set<string>,
): string | null {
  for (const item of items) {
    if (!deletedDocumentIds.has(item.id)) {
      return item.id
    }

    const childDocumentId = findFirstAvailableDocumentId(item.children, deletedDocumentIds)

    if (childDocumentId) {
      return childDocumentId
    }
  }

  return null
}

function applyDocumentItemPatch(item: DocumentItem, input: Partial<DocumentItem>): DocumentItem {
  const patchKeys = Object.keys(input) as Array<keyof DocumentItem>

  if (!patchKeys.length) {
    return item
  }

  const hasChanges = patchKeys.some(key => item[key] !== input[key])

  if (!hasChanges) {
    return item
  }

  return {
    ...item,
    ...input,
  }
}
