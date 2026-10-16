import type {
  DocumentItem,
  DocumentTreeGroup,
} from '@haohaoxue/lexora-contracts'
import type { ComputedRef } from 'vue'
import type { DocumentDeletePlan } from '../utils/documentTree'
import { formatDocumentCollectionLabel } from '@haohaoxue/lexora-shared/document'
import { computed, shallowRef } from 'vue'
import { getDocuments } from '@/apis/document'
import { translate } from '@/i18n'
import { useUiStore } from '@/stores/ui'
import {
  findDocumentPath,
  resolveDocumentDeletePlan,
  resolvePreferredDocumentId,
  updateDocumentBranch,
} from '../utils/documentTree'

export interface LoadDocumentTreeOptions {
  silent?: boolean
}

interface UseDocumentTreeDataOptions {
  activeDocumentId: ComputedRef<string | null>
  currentWorkspaceId: ComputedRef<string | null>
}

export function useDocumentTreeData(options: UseDocumentTreeDataOptions) {
  const uiStore = useUiStore()
  const treeGroups = shallowRef<DocumentTreeGroup[]>([])
  const isDocumentLoading = shallowRef(false)
  let treeRequestId = 0

  const lastOpenedDocumentId = computed(() =>
    uiStore.getLastOpenedDocumentId(options.currentWorkspaceId.value),
  )
  const activePath = computed(() =>
    options.activeDocumentId.value ? findDocumentPath(treeGroups.value, options.activeDocumentId.value) : null,
  )
  const activeCollectionId = computed(() => activePath.value?.collectionId ?? null)
  const defaultDocumentId = computed(() => resolvePreferredDocumentId(
    treeGroups.value,
    lastOpenedDocumentId.value,
  ))
  const breadcrumbLabels = computed(() => {
    if (!activePath.value) {
      return [translate('docs.common.documents')]
    }

    return [
      formatDocumentCollectionLabel(activePath.value.collectionId),
      ...activePath.value.nodes.map(document => document.title),
    ]
  })

  async function loadTree(loadOptions: LoadDocumentTreeOptions = {}) {
    const workspaceId = options.currentWorkspaceId.value
    const requestId = ++treeRequestId
    const shouldShowLoading = !loadOptions.silent

    if (!workspaceId) {
      isDocumentLoading.value = false
      treeGroups.value = []
      return
    }

    if (shouldShowLoading) {
      isDocumentLoading.value = true
    }

    try {
      const groups = await getDocuments(workspaceId)

      if (!isActiveTreeRequest(requestId, workspaceId)) {
        return
      }

      treeGroups.value = groups
    }
    finally {
      if (shouldShowLoading && isActiveTreeRequest(requestId, workspaceId)) {
        isDocumentLoading.value = false
      }
    }
  }

  function patchDocumentItem(documentId: string, input: Partial<DocumentItem>) {
    const currentGroups = treeGroups.value

    for (let index = 0; index < currentGroups.length; index += 1) {
      const group = currentGroups[index]
      const nextNodes = updateDocumentBranch(group.nodes, documentId, input)

      if (nextNodes === group.nodes) {
        continue
      }

      const nextGroups = currentGroups.slice()
      nextGroups[index] = {
        ...group,
        nodes: nextNodes,
      }
      treeGroups.value = nextGroups
      return
    }
  }

  function resolveDeletePlan(documentIds: string[]): DocumentDeletePlan | null {
    return resolveDocumentDeletePlan(
      treeGroups.value,
      documentIds,
      options.activeDocumentId.value,
    )
  }

  function rememberLastOpenedDocument(documentId: string) {
    uiStore.setLastOpenedDocumentId(options.currentWorkspaceId.value, documentId)
  }

  function isActiveTreeRequest(requestId: number, workspaceId: string | null) {
    return requestId === treeRequestId && options.currentWorkspaceId.value === workspaceId
  }

  return {
    activeCollectionId,
    breadcrumbLabels,
    defaultDocumentId,
    isDocumentLoading,
    loadTree,
    patchDocumentItem,
    rememberLastOpenedDocument,
    resolveDeletePlan,
    treeGroups,
  }
}
