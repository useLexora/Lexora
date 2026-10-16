import type { JSONContent } from '@tiptap/core'
import type { TiptapEditorUploadedFile, TiptapEditorUploadedImage } from './typing'

export function createUploadedImageInsertContent(uploadedImage: TiptapEditorUploadedImage): JSONContent[] {
  return [
    {
      type: 'image',
      attrs: {
        assetId: uploadedImage.id,
        alt: uploadedImage.fileName,
        width: uploadedImage.width,
        height: uploadedImage.height,
      },
    },
    {
      type: 'paragraph',
    },
  ]
}

export function createUploadedFileInsertContent(uploadedFile: TiptapEditorUploadedFile): JSONContent[] {
  return [
    {
      type: 'file',
      attrs: {
        assetId: uploadedFile.id,
        fileName: uploadedFile.fileName,
        mimeType: uploadedFile.mimeType,
        size: uploadedFile.size,
      },
    },
    {
      type: 'paragraph',
    },
  ]
}
