import type { JSONContent } from '@tiptap/core'
import type { TiptapEditorUploadedFile, TiptapEditorUploadedImage } from './typing'
import {
  createUploadedFileInsertContent,
  createUploadedImageInsertContent,
} from './documentAsset'
import { createTextInsertContent } from './textInsertContent'

export { splitPlainTextParagraphLines } from './textInsertContent'

export function createPlainTextPasteContent(text: string): JSONContent[] {
  return createTextInsertContent(text)
}

export async function createFilePasteContent(
  files: readonly File[],
  options: {
    uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
    uploadFile?: (file: File) => Promise<TiptapEditorUploadedFile>
  } = {},
): Promise<JSONContent[]> {
  const content = (await Promise.all(files.map(async (file) => {
    if (file.type.startsWith('image/')) {
      if (options.uploadImage) {
        return createUploadedImageInsertContent(await options.uploadImage(file))
      }
    }
    else if (options.uploadFile) {
      return createUploadedFileInsertContent(await options.uploadFile(file))
    }

    return [{
      type: 'paragraph',
      content: [{ type: 'text', text: file.name }],
    }]
  }))).flat()

  if (!content.length) {
    return content
  }

  const lastNode = content.at(-1)

  if (lastNode?.type === 'paragraph') {
    return content
  }

  return [...content, { type: 'paragraph' }]
}
