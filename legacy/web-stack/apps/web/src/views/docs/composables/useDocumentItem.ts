import type { DocumentItem, DocumentTreeCollectionId } from '@haohaoxue/lexora-contracts'
import { buildDocumentPath } from '@haohaoxue/lexora-shared/document'
import { useClipboard } from '@vueuse/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from '@/utils/element-plus'
import { isOwnedDocumentCollection } from '../utils/documentTree'
import { useDocsContext } from './useDocsContext'
import { useDocsPageActions } from './useDocsPageActions'
import { useDocumentTree } from './useDocumentTree'

export interface UseDocumentItemOptions {
  item: () => DocumentItem
  collectionId: () => DocumentTreeCollectionId
}

type DocumentTreeItemMenuCommand
  = | 'copy-link'
    | 'delete'
    | 'duplicate'
    | 'move'
    | 'open-new-tab'
    | 'rename'

const DOCUMENT_TREE_ITEM_MENU_COMMANDS: readonly DocumentTreeItemMenuCommand[] = [
  'copy-link',
  'delete',
  'duplicate',
  'move',
  'open-new-tab',
  'rename',
]

interface DocumentTreeItemMenuItem {
  command: DocumentTreeItemMenuCommand
  label: string
  icon: string
  divided?: boolean
  danger?: boolean
}

export function useDocumentItem(options: UseDocumentItemOptions) {
  const { activeDocumentId } = useDocsContext()
  const { t } = useI18n()
  const tree = useDocumentTree()
  const pageActions = useDocsPageActions()
  const { copy, isSupported: isClipboardSupported } = useClipboard({
    legacy: true,
  })

  const item = computed(options.item)
  const collectionId = computed(options.collectionId)
  const isActive = computed(() => activeDocumentId.value === item.value.id)
  const canManageDocument = computed(() =>
    isOwnedDocumentCollection(collectionId.value),
  )
  const isActionPending = computed(() =>
    tree.isMutatingTree.value || pageActions.isDocumentOperationRunning.value,
  )

  function createChild() {
    void tree.createChildDocument(item.value.id)
  }

  function openDocumentInNewTab() {
    window.open(buildDocumentPath(item.value.id), '_blank', 'noopener,noreferrer')
  }

  async function copyDocumentLink() {
    if (!isClipboardSupported.value) {
      ElMessage.error(t('docs.common.copyUnsupported'))
      return
    }

    try {
      await copy(new URL(buildDocumentPath(item.value.id), window.location.origin).toString())
      ElMessage.success(t('docs.treeMenu.linkCopied'))
    }
    catch {
      ElMessage.error(t('docs.treeMenu.copyLinkFailed'))
    }
  }

  function duplicateDocument() {
    void pageActions.duplicateDocumentTree(item.value.id)
  }

  function moveDocument() {
    tree.openMoveDialog(item.value.id)
  }

  function renameDocument() {
    tree.openRenameDialog(item.value.id)
  }

  function deleteDocument() {
    void tree.deleteDocument(item.value.id)
  }

  const itemStateClass = computed(() => isActive.value ? 'active' : 'idle')
  const actionsStateClass = computed(() => isActive.value ? 'visible' : 'hidden')
  const menuItems = computed<DocumentTreeItemMenuItem[]>(() => {
    const items: DocumentTreeItemMenuItem[] = [{
      command: 'open-new-tab',
      label: t('docs.treeMenu.openNewTab'),
      icon: 'document-menu-open-new',
    }]

    items.push({
      command: 'copy-link',
      label: t('docs.treeMenu.copyLink'),
      icon: 'link',
      divided: true,
    })

    if (canManageDocument.value) {
      items.push(
        {
          command: 'duplicate',
          label: t('docs.treeMenu.duplicate'),
          icon: 'document-menu-copy',
          divided: true,
        },
        {
          command: 'move',
          label: t('docs.treeMenu.move'),
          icon: 'document-menu-move',
        },
        {
          command: 'rename',
          label: t('docs.treeMenu.rename'),
          icon: 'document-menu-rename',
          divided: true,
        },
        {
          command: 'delete',
          label: t('docs.common.delete'),
          icon: 'trash-can',
          divided: true,
          danger: true,
        },
      )
    }

    return items
  })
  const menuCommandHandlers: Record<DocumentTreeItemMenuCommand, () => void> = {
    'copy-link': () => void copyDocumentLink(),
    'delete': () => canManageDocument.value && deleteDocument(),
    'duplicate': () => canManageDocument.value && duplicateDocument(),
    'move': () => canManageDocument.value && moveDocument(),
    'open-new-tab': openDocumentInNewTab,
    'rename': () => canManageDocument.value && renameDocument(),
  }

  function handleMenuCommand(command: unknown) {
    if (typeof command !== 'string') {
      return
    }

    if (isDocumentTreeItemMenuCommand(command)) {
      menuCommandHandlers[command]()
    }
  }

  return {
    actionsStateClass,
    canManageDocument,
    createChild,
    deleteDocument,
    handleMenuCommand,
    isActionPending,
    itemStateClass,
    menuItems,
  }
}

function isDocumentTreeItemMenuCommand(command: string): command is DocumentTreeItemMenuCommand {
  return DOCUMENT_TREE_ITEM_MENU_COMMANDS.includes(command as DocumentTreeItemMenuCommand)
}
