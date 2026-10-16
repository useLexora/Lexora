import type { Editor } from '@tiptap/core'
import type { ShallowRef, TemplateRef } from 'vue'
import type {
  TiptapEditorCommentRequest,
  TiptapEditorHandleKeyDown,
  TiptapEditorHandleTextInput,
  TiptapEditorSelectionContextRequest,
} from '../../core/typing'
import type { BlockTriggerMenuExposed } from '../../overlays/block-trigger/typing'
import type { DocumentBodyEditorProps } from './typing'
import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { TextSelection } from '@tiptap/pm/state'
import {
  computed,
  nextTick,
  shallowRef,
  watch,
} from 'vue'
import {
  resolveDocumentAssets as resolveDocumentAssetsRequest,
  uploadDocumentFile,
  uploadDocumentImage,
} from '@/apis/document'
import { translate } from '@/i18n'
import { createBodyExtensions } from '../../extensions/createExtensions'
import {
  clearDocumentAiDraftPreview,
  setDocumentAiDraftPreview,
} from '../../extensions/DocumentAiDraftPreview'
import { scrollDocumentBlockIntoView } from '../../overlays/block-trigger/blockTriggerDom'
import { isTriggerMenuSelection } from './triggerSelection'

const DOCUMENT_IMAGE_SIZE_LIMIT_LABEL = prettyBytes(FILE_SIZE_LIMITS.DOCUMENT_IMAGE)

export function useDocumentBodyEditor(options: {
  blockTriggerMenuRef: TemplateRef<BlockTriggerMenuExposed | null>
  bodyEditor: ShallowRef<Editor | null>
  onAcceptAiDraftPreview: (candidateId: string) => void
  onRequestComment: (request: TiptapEditorCommentRequest) => void
  onRejectAiDraftPreview: (candidateId: string) => void
  onSelectionChange: (request: TiptapEditorSelectionContextRequest) => void
  props: DocumentBodyEditorProps
}) {
  const bodyEditorExtensions = createBodyExtensions({
    uploadImage: handleUploadImage,
    uploadFile: handleUploadFile,
    resolveImageSrc: resolveDocumentImageSrc,
    aiDraftPreview: {
      onAccept: candidateId => options.onAcceptAiDraftPreview(candidateId),
      onReject: candidateId => options.onRejectAiDraftPreview(candidateId),
    },
  })
  const bodyEditor = computed(() => options.bodyEditor.value)
  const pendingActiveBlockId = shallowRef<string | null>(null)
  const isResolvingActiveBlock = shallowRef(false)
  const imageSrcCache = new Map<string, Promise<string | null>>()

  watch(
    [
      bodyEditor,
      () => options.props.activeBlockId,
    ],
    async ([editor, activeBlockId]) => {
      pendingActiveBlockId.value = activeBlockId ?? null

      if (!editor || !activeBlockId) {
        return
      }

      await scrollToPendingActiveBlock(editor)
    },
    {
      immediate: true,
      flush: 'post',
    },
  )

  watch(
    [
      bodyEditor,
      () => options.props.aiDraftPreview,
    ],
    ([editor, preview]) => {
      if (!editor) {
        return
      }

      if (!preview) {
        clearDocumentAiDraftPreview(editor)
        return
      }

      setDocumentAiDraftPreview(editor, {
        id: preview.id,
        intent: preview.intent,
        previewMode: preview.previewMode,
        from: preview.from,
        to: preview.to,
        candidateContent: preview.candidateContent,
      })
    },
    {
      immediate: true,
      flush: 'post',
    },
  )

  watch(
    bodyEditor,
    (editor, _previousEditor, onCleanup) => {
      if (!editor) {
        return
      }

      const emitSelectionChange = () => emitTextSelectionChange(editor)

      if (typeof editor.on !== 'function' || typeof editor.off !== 'function') {
        return
      }

      editor.on('selectionUpdate', emitSelectionChange)
      editor.on('focus', emitSelectionChange)
      emitSelectionChange()

      onCleanup(() => {
        editor.off('selectionUpdate', emitSelectionChange)
        editor.off('focus', emitSelectionChange)
      })
    },
    {
      immediate: true,
      flush: 'post',
    },
  )

  watch(
    [
      bodyEditor,
      () => options.props.content,
    ],
    async ([editor]) => {
      if (!editor || !pendingActiveBlockId.value) {
        return
      }

      await scrollToPendingActiveBlock(editor)
    },
    {
      flush: 'post',
    },
  )

  const handleBodyEditorKeyDown: TiptapEditorHandleKeyDown = (_, event) => {
    const editor = bodyEditor.value

    if (!options.props.editable || !editor) {
      return false
    }

    if (event.key !== '/' || !isTriggerMenuSelection(editor)) {
      return false
    }

    return openBlockTriggerMenu(() => event.preventDefault())
  }

  const handleBodyEditorTextInput: TiptapEditorHandleTextInput = (_, __, ___, text) => {
    const editor = bodyEditor.value

    if (!options.props.editable || !editor || text !== '/' || !isTriggerMenuSelection(editor)) {
      return false
    }

    return openBlockTriggerMenu()
  }

  function handleCommentRequest(request: TiptapEditorCommentRequest) {
    options.onRequestComment(request)
  }

  function handleBodyEditorChange(editor: Editor | null) {
    options.bodyEditor.value = editor
  }

  function emitTextSelectionChange(editor: Editor) {
    const { selection } = editor.state

    if (!(selection instanceof TextSelection)) {
      return
    }

    options.onSelectionChange({
      editor,
      from: selection.from,
      to: selection.to,
    })
  }

  return {
    bodyEditor,
    bodyEditorExtensions,
    handleBodyEditorChange,
    handleBodyEditorKeyDown,
    handleBodyEditorTextInput,
    handleCommentRequest,
    handleUploadFile,
    handleUploadImage,
  }

  function openBlockTriggerMenu(onOpened?: () => void) {
    const opened = options.blockTriggerMenuRef.value?.openMenu() ?? false

    if (!opened) {
      return false
    }

    onOpened?.()
    return true
  }

  async function handleUploadImage(file: File) {
    if (!options.props.documentId) {
      throw new Error(translate('editor.upload.notReadyImage'))
    }

    if (file.size > FILE_SIZE_LIMITS.DOCUMENT_IMAGE) {
      throw new Error(translate('editor.upload.imageTooLarge', { size: DOCUMENT_IMAGE_SIZE_LIMIT_LABEL }))
    }

    const asset = await uploadDocumentImage(options.props.documentId, file)

    if (asset.contentUrl) {
      imageSrcCache.set(`${options.props.documentId}:${asset.id}`, Promise.resolve(asset.contentUrl))
    }

    return asset
  }

  async function handleUploadFile(file: File) {
    if (!options.props.documentId) {
      throw new Error(translate('editor.upload.notReadyAttachment'))
    }

    return uploadDocumentFile(options.props.documentId, file)
  }

  async function resolveDocumentImageSrc(assetId: string) {
    const documentId = options.props.documentId

    if (!documentId) {
      return null
    }

    const cacheKey = `${documentId}:${assetId}`
    const cachedSrc = imageSrcCache.get(cacheKey)

    if (cachedSrc) {
      return cachedSrc
    }

    const pendingSrc = resolveDocumentAssetsRequest(documentId, {
      assetIds: [assetId],
    }).then((response) => {
      const asset = response.assets.find(item => item.id === assetId)
      return asset?.contentUrl ?? null
    }).catch((error) => {
      imageSrcCache.delete(cacheKey)
      throw error
    })

    imageSrcCache.set(cacheKey, pendingSrc)
    return pendingSrc
  }

  async function scrollToPendingActiveBlock(editor: Editor) {
    const blockId = pendingActiveBlockId.value

    if (!blockId || isResolvingActiveBlock.value) {
      return
    }

    isResolvingActiveBlock.value = true

    try {
      await nextTick()

      if (!scrollDocumentBlockIntoView(editor, blockId)) {
        return
      }

      pendingActiveBlockId.value = null
    }
    finally {
      isResolvingActiveBlock.value = false
    }
  }
}
