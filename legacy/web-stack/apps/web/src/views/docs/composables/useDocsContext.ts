import type { WorkspaceType } from '@haohaoxue/lexora-contracts'
import type { TiptapEditorCommentRequest } from '@/components/tiptap-editor'
import { createSharedComposable } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { translate } from '@/i18n'
import { useWorkspaceStore } from '@/stores/workspace'
import { resolveDocumentBlockIdFromHash } from '@/utils/documentBlockAnchor'
import { ElMessage } from '@/utils/element-plus'

export interface NavigateToDocumentOptions {
  replace?: boolean
  skipConfirm?: boolean
  focusTitle?: boolean
}

type DocumentNavigationConfirmationHandler = () => Promise<boolean>

export function createDocumentNavigationConfirmation() {
  let handler: DocumentNavigationConfirmationHandler | null = null

  async function confirm() {
    return handler ? await handler() : true
  }

  function setHandler(nextHandler: DocumentNavigationConfirmationHandler) {
    handler = nextHandler
  }

  return {
    confirm,
    setHandler,
  }
}

export const useDocsContext = createSharedComposable(() => {
  const route = useRoute()
  const router = useRouter()
  const workspaceStore = useWorkspaceStore()

  const activeDocumentId = computed(() => typeof route.params.id === 'string' ? route.params.id : null)
  const activeBlockId = computed(() => resolveDocumentBlockIdFromHash(route.hash))
  const currentWorkspaceId = computed(() => workspaceStore.currentWorkspace?.id ?? null)
  const currentWorkspaceType = computed<WorkspaceType>(() => workspaceStore.currentWorkspaceType)
  const routeName = computed(() => route.name)
  const routeKey = computed(() => route.fullPath)
  const isSelectingInitialDocument = shallowRef(false)
  const pendingHistoryDocumentId = shallowRef<string | null>(null)
  const pendingTitleFocusDocumentId = shallowRef<string | null>(null)
  const navigationConfirmation = createDocumentNavigationConfirmation()

  async function confirmNavigation() {
    return await navigationConfirmation.confirm()
  }

  async function navigateToDocument(
    documentId: string | null,
    options: NavigateToDocumentOptions = {},
  ) {
    if (documentId === activeDocumentId.value) {
      if (options.focusTitle && documentId) {
        pendingTitleFocusDocumentId.value = documentId
      }

      return true
    }

    if (!options.skipConfirm) {
      const canNavigate = await confirmNavigation()

      if (!canNavigate) {
        return false
      }
    }

    if (options.focusTitle && documentId) {
      pendingTitleFocusDocumentId.value = documentId
    }

    await router[options.replace ? 'replace' : 'push']({
      name: 'docs',
      ...(documentId ? { params: { id: documentId } } : {}),
      hash: '',
    })

    return true
  }

  function handleRequestComment(request: TiptapEditorCommentRequest) {
    void request
    ElMessage.info(translate('docs.common.commentComingSoon'))
  }

  return {
    activeBlockId,
    activeDocumentId,
    confirmNavigation,
    currentWorkspaceId,
    currentWorkspaceType,
    handleRequestComment,
    isSelectingInitialDocument,
    navigateToDocument,
    pendingHistoryDocumentId,
    pendingTitleFocusDocumentId,
    routeKey,
    routeName,
    setNavigationConfirmationHandler: navigationConfirmation.setHandler,
  }
})
