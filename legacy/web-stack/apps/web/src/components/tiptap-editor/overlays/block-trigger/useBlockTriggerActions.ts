import type { Editor } from '@tiptap/core'
import type { Ref } from 'vue'
import type { TiptapEditorUploadedFile, TiptapEditorUploadedImage } from '../../content/typing'
import type { TiptapEditorBlockContextRequest, TiptapEditorCommentRequest } from '../../core/typing'
import type {
  BlockMenuChildItem,
  BlockMenuItem,
  BlockMenuQuickItem,
} from '../catalog/menuRegistry'
import type { LinkPanelController } from '../shared/useLinkPanel'
import type { BlockTriggerPanel } from './useBlockTriggerOverlay'
import { getCurrentBlock } from '../../commands/currentBlock'
import { BODY_BLOCK_ID_ATTRIBUTE } from '../../content/blockId'
import { createMenuActionRegistry } from '../catalog/actionRegistry'

export function useBlockTriggerActions(options: {
  editor: Editor
  openPanel: (panel: Exclude<BlockTriggerPanel, 'root'>) => boolean
  openLinkPanel: () => boolean
  closeMenu: () => void
  imageInputRef: Ref<HTMLInputElement | null>
  fileInputRef: Ref<HTMLInputElement | null>
  linkPanel: LinkPanelController
  onRequestAiBlockRewrite?: (request: TiptapEditorBlockContextRequest) => void
  onRequestComment: (request: TiptapEditorCommentRequest) => void
  uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
  uploadFile?: (file: File) => Promise<TiptapEditorUploadedFile>
}) {
  const actionRegistry = createMenuActionRegistry({
    editor: options.editor,
    linkPanel: options.linkPanel,
    closeMenu: options.closeMenu,
    onRequestComment: options.onRequestComment,
    commentSource: 'block-menu',
    imageInputRef: options.imageInputRef,
    fileInputRef: options.fileInputRef,
    uploadImage: options.uploadImage,
    uploadFile: options.uploadFile,
  })

  return {
    applyTextColor,
    applyBackgroundColor,
    handleQuickItemClick,
    handleMenuItemClick,
    handleAlignItemClick,
    handlePickImageResult,
    handlePickFileResult,
  }

  function handleQuickItemClick(item: BlockMenuQuickItem) {
    if (item.kind === 'turn-into') {
      return actionRegistry.turnInto.execute(item.target)
    }

    const quickActionHandlers = {
      'insert-link': () => {
        options.openLinkPanel()
      },
      'insert-inline-math': () => actionRegistry.quickInsert.execute('insert-inline-math'),
      'insert-image': () => actionRegistry.quickInsert.execute('insert-image'),
      'insert-file': () => actionRegistry.quickInsert.execute('insert-file'),
    } as const satisfies Record<Exclude<BlockMenuQuickItem['kind'], 'turn-into'>, () => void | Promise<void>>

    return quickActionHandlers[item.kind]()
  }

  function handleMenuItemClick(item: BlockMenuItem) {
    if (item.kind === 'panel') {
      return options.openPanel(item.action)
    }

    if (item.action === 'rewrite-block') {
      return requestAiBlockRewrite()
    }

    return actionRegistry.leaf.execute(item.action)
  }

  function handleAlignItemClick(item: BlockMenuChildItem) {
    if (item.kind === 'indent' && item.disabled) {
      return
    }

    if (item.kind === 'text-align') {
      return actionRegistry.align.executeTextAlign(item.action)
    }

    return actionRegistry.align.executeIndent(item.action)
  }

  function applyTextColor(color: string) {
    const range = getCurrentBlockTextRange()

    if (!range) {
      return
    }

    actionRegistry.colors.applyText(color, range)
  }

  function applyBackgroundColor(color: string) {
    const range = getCurrentBlockTextRange()

    if (!range) {
      return
    }

    actionRegistry.colors.applyBackground(color, range)
  }

  function getCurrentBlockTextRange() {
    const { $from } = options.editor.state.selection
    const from = $from.start()
    const to = $from.end()

    if (from >= to) {
      return null
    }

    return { from, to }
  }

  function requestAiBlockRewrite() {
    const currentBlock = getCurrentBlock(options.editor.state.selection)
    const blockId = currentBlock?.node.attrs[BODY_BLOCK_ID_ATTRIBUTE]

    if (!currentBlock || typeof blockId !== 'string' || !blockId) {
      return
    }

    options.closeMenu()
    options.onRequestAiBlockRewrite?.({
      editor: options.editor,
      blockId,
      from: currentBlock.from,
      to: currentBlock.to,
    })
  }

  function handlePickImageResult(event: Event) {
    void actionRegistry.uploads.handleFileInsert(event, 'image')
  }

  function handlePickFileResult(event: Event) {
    void actionRegistry.uploads.handleFileInsert(event, 'file')
  }
}
