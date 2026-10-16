import type { Editor } from '@tiptap/core'
import type { TiptapEditorUploadedFile, TiptapEditorUploadedImage } from '../content/typing'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import {
  createAnimatedGifPasteFile,
  hasAnimatedGifPasteSource,
} from '../content/animatedGifPaste'
import {
  LEXORA_BLOCK_CLIPBOARD_TYPE,
  parseStructuredClipboardContent,
} from '../content/blockClipboard'
import {
  createMarkdownInsertContent,
  hasMarkdownInsertBlockSyntax,
} from '../content/markdownContent'
import { createFilePasteContent } from '../content/pasteContent'
import { uploadImagesWithPlaceholder } from './ImageUploadPlaceholder'

export interface PastePipelineOptions {
  uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
  uploadFile?: (file: File) => Promise<TiptapEditorUploadedFile>
}

export const PastePipeline = Extension.create<PastePipelineOptions>({
  name: 'pastePipeline',

  addOptions() {
    return {
      uploadImage: undefined,
      uploadFile: undefined,
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(this.name),
        props: {
          handlePaste: (_, event) => handleEditorPaste(this.editor, event, this.options),
        },
      }),
    ]
  },
})

function handleEditorPaste(editor: Editor, event: ClipboardEvent, options: PastePipelineOptions) {
  if (!editor.isEditable || !event.clipboardData) {
    return false
  }

  const files = Array.from(event.clipboardData.files ?? [])
  const html = event.clipboardData.getData('text/html').trim()
  const text = event.clipboardData.getData('text/plain')
  const preferPlain = isPreferPlainPaste(editor)

  if (files.length) {
    event.preventDefault()
    void handleFilePaste(editor, files, options, html)
    return true
  }

  if (isSelectionInsideCodeBlock(editor)) {
    if (!text.length) {
      return false
    }

    event.preventDefault()
    dispatchPlainTextPaste(editor, text)
    return true
  }

  if (!preferPlain) {
    const structuredContent = parseStructuredClipboardContent(
      event.clipboardData.getData(LEXORA_BLOCK_CLIPBOARD_TYPE),
    )

    if (structuredContent?.length) {
      return editor.chain().focus().insertContent(structuredContent).run()
    }
  }

  if (shouldInsertPlainTextInline(editor, text, html, preferPlain)) {
    dispatchPlainTextPaste(editor, text)
    return true
  }

  if (shouldInsertMarkdownTextBlocks(text, html, preferPlain)) {
    event.preventDefault()
    return editor
      .chain()
      .focus()
      .insertContent(createMarkdownInsertContent(editor, text))
      .run()
  }

  if (!preferPlain && html.length) {
    if (options.uploadImage && hasAnimatedGifPasteSource(html)) {
      event.preventDefault()
      void handleAnimatedGifPaste(editor, html, options)
      return true
    }
  }

  return false
}

function dispatchPlainTextPaste(editor: Editor, text: string) {
  editor.view.dispatch(
    editor.state.tr
      .insertText(text)
      .scrollIntoView()
      .setMeta('paste', true)
      .setMeta('uiEvent', 'paste'),
  )
}

function shouldInsertPlainTextInline(editor: Editor, text: string, html: string, preferPlain: boolean) {
  if (!text.length || /[\r\n]/.test(text)) {
    return false
  }

  if (hasMarkdownInsertBlockSyntax(text)) {
    return false
  }

  if (html.length && !preferPlain) {
    return false
  }

  const { $from, $to } = editor.state.selection

  return $from.sameParent($to)
    && $from.parent.isTextblock
    && !($from.parent.type.spec.code)
}

function shouldInsertMarkdownTextBlocks(text: string, html: string, preferPlain: boolean) {
  return !preferPlain
    && text.length > 0
    && hasMarkdownInsertBlockSyntax(text)
    && !hasSemanticCodeBlockHtml(html)
}

function hasSemanticCodeBlockHtml(html: string) {
  return /<pre\b[\s\S]*<code\b/i.test(html)
    || /<code\b[\s\S]*<\/code>/i.test(html)
}

function isPreferPlainPaste(editor: Editor) {
  const viewInput = editor.view as unknown as {
    input?: {
      lastKeyCode?: number
      shiftKey?: boolean
    }
  }

  return Boolean(viewInput.input?.shiftKey && viewInput.input.lastKeyCode !== 45)
}

function isSelectionInsideCodeBlock(editor: Editor) {
  const { $from, $to } = editor.state.selection

  return $from.parent.type.name === 'codeBlock' && $to.parent.type.name === 'codeBlock'
}

async function handleFilePaste(
  editor: Editor,
  files: readonly File[],
  options: PastePipelineOptions,
  html: string,
) {
  try {
    const uploadFiles = await mergeAnimatedGifIntoFiles(files, options, html)

    if (shouldUploadImagesWithPlaceholder(uploadFiles, options)) {
      await uploadImagesWithPlaceholder(editor, uploadFiles, options.uploadImage)
      return
    }

    const content = await createFilePasteContent(uploadFiles, {
      uploadImage: options.uploadImage,
      uploadFile: options.uploadFile,
    })

    if (!content.length) {
      return
    }

    editor.chain().focus().insertContent(content).run()
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(
      error,
      files.every(file => file.type.startsWith('image/')) ? translate('editor.upload.imageFailed') : translate('editor.upload.assetFailed'),
    ))
  }
}

async function handleAnimatedGifPaste(
  editor: Editor,
  html: string,
  options: PastePipelineOptions,
) {
  try {
    const animatedGifFile = await createAnimatedGifPasteFile(html)

    if (!animatedGifFile) {
      editor.chain().focus().insertContent(html).run()
      return
    }

    if (!options.uploadImage) {
      editor.chain().focus().insertContent(html).run()
      return
    }

    await uploadImagesWithPlaceholder(editor, [animatedGifFile], options.uploadImage)
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, translate('editor.upload.imageFailed')))
  }
}

function shouldUploadImagesWithPlaceholder(
  files: readonly File[],
  options: PastePipelineOptions,
): options is PastePipelineOptions & { uploadImage: (file: File) => Promise<TiptapEditorUploadedImage> } {
  return Boolean(options.uploadImage)
    && files.length > 0
    && files.every(file => file.type.startsWith('image/'))
}

async function mergeAnimatedGifIntoFiles(
  files: readonly File[],
  options: PastePipelineOptions,
  html: string,
): Promise<readonly File[]> {
  if (!options.uploadImage || !html || !hasAnimatedGifPasteSource(html)) {
    return files
  }

  try {
    const animatedGifFile = await createAnimatedGifPasteFile(html)

    if (!animatedGifFile) {
      return files
    }

    return [
      animatedGifFile,
      ...files.filter(file => !file.type.startsWith('image/')),
    ]
  }
  catch {
    // Clipboard files are still a valid paste result; GIF replacement is best-effort.
    return files
  }
}
