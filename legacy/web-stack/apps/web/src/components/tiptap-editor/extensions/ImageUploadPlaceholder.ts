import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import type { TiptapEditorUploadedImage } from '../content/typing'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { translate } from '@/i18n'
import { createUploadedImageInsertContent } from '../content/documentAsset'

interface ImageUploadPlaceholderRecord {
  detail: string
  from: number
  id: string
  label: string
  previewUrl: string | null
  to: number
}

interface ImageUploadPlaceholderState {
  decorations: DecorationSet
  placeholders: ImageUploadPlaceholderRecord[]
}

interface ImageUploadJob {
  file: File
  placeholderId: string
}

type ImageUploadPlaceholderMeta
  = | {
    placeholder: ImageUploadPlaceholderRecord
    type: 'add'
  }
  | {
    id: string
    type: 'remove'
  }

let imageUploadPlaceholderCounter = 0

export const imageUploadPlaceholderPluginKey = new PluginKey<ImageUploadPlaceholderState>('imageUploadPlaceholder')

export const ImageUploadPlaceholder = Extension.create({
  name: 'imageUploadPlaceholder',

  addProseMirrorPlugins() {
    return [
      new Plugin<ImageUploadPlaceholderState>({
        key: imageUploadPlaceholderPluginKey,
        state: {
          init: (_, state) => createPlaceholderState(state.doc, []),
          apply: (transaction, value) => {
            const meta = transaction.getMeta(imageUploadPlaceholderPluginKey) as ImageUploadPlaceholderMeta | undefined

            if (!value.placeholders.length && !meta) {
              return value
            }

            let placeholders = value.placeholders.map(placeholder => mapPlaceholder(transaction, placeholder))

            if (meta?.type === 'add') {
              placeholders = [...placeholders, meta.placeholder]
            }
            else if (meta?.type === 'remove') {
              placeholders = placeholders.filter(placeholder => placeholder.id !== meta.id)
            }

            return createPlaceholderState(transaction.doc, placeholders)
          },
        },
        props: {
          attributes: (state): Record<string, string> => {
            const hasPlaceholder = Boolean(imageUploadPlaceholderPluginKey.getState(state)?.placeholders.length)

            return hasPlaceholder
              ? { 'data-tiptap-image-upload-placeholder-active': 'true' }
              : {}
          },
          decorations: state => imageUploadPlaceholderPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ]
  },
})

export function uploadImagesWithPlaceholder(
  editor: Editor,
  files: readonly File[],
  uploadImage: (file: File) => Promise<TiptapEditorUploadedImage>,
) {
  if (!isEditorUsable(editor) || !files.length) {
    return Promise.resolve()
  }

  const uploadJobs = files
    .map(file => ({
      file,
      placeholderId: addImageUploadPlaceholder(editor, [file]),
    }))
    .filter((job): job is ImageUploadJob => Boolean(job.placeholderId))

  return uploadImageJobsWithPlaceholder(editor, uploadJobs, uploadImage)
}

async function uploadImageJobsWithPlaceholder(
  editor: Editor,
  uploadJobs: readonly ImageUploadJob[],
  uploadImage: (file: File) => Promise<TiptapEditorUploadedImage>,
) {
  let firstError: unknown

  for (const uploadJob of uploadJobs) {
    if (!isEditorUsable(editor)) {
      return
    }

    try {
      await uploadImageWithPlaceholder(editor, uploadJob, uploadImage)
    }
    catch (error) {
      firstError ??= error
    }
  }

  if (firstError) {
    throw firstError
  }
}

async function uploadImageWithPlaceholder(
  editor: Editor,
  uploadJob: ImageUploadJob,
  uploadImage: (file: File) => Promise<TiptapEditorUploadedImage>,
) {
  try {
    const uploadedImage = await uploadImage(uploadJob.file)

    if (!isEditorUsable(editor)) {
      return
    }

    const content = createUploadedImageInsertContent(uploadedImage)

    if (!replaceImageUploadPlaceholder(editor, uploadJob.placeholderId, content) && isEditorUsable(editor)) {
      editor.chain().focus().insertContent(content).run()
    }
  }
  catch (error) {
    if (!isEditorUsable(editor)) {
      return
    }

    removeImageUploadPlaceholder(editor, uploadJob.placeholderId)
    throw error
  }
}

function addImageUploadPlaceholder(editor: Editor, files: readonly File[]) {
  if (!isEditorUsable(editor)) {
    return null
  }

  const id = `image-upload-${Date.now()}-${imageUploadPlaceholderCounter += 1}`
  const { from, to } = editor.state.selection
  const placeholder = createPlaceholderRecord(id, from, to, files)

  editor.view.dispatch(
    editor.state.tr
      .setMeta(imageUploadPlaceholderPluginKey, {
        type: 'add',
        placeholder,
      } satisfies ImageUploadPlaceholderMeta)
      .scrollIntoView(),
  )

  return id
}

function removeImageUploadPlaceholder(editor: Editor, id: string) {
  if (!isEditorUsable(editor)) {
    return false
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(imageUploadPlaceholderPluginKey, {
      type: 'remove',
      id,
    } satisfies ImageUploadPlaceholderMeta),
  )

  return true
}

function replaceImageUploadPlaceholder(editor: Editor, id: string, content: JSONContent[]) {
  if (!isEditorUsable(editor)) {
    return false
  }

  const range = findImageUploadPlaceholderRange(editor, id)

  if (!range) {
    return false
  }

  return editor
    .chain()
    .focus()
    .setMeta(imageUploadPlaceholderPluginKey, {
      type: 'remove',
      id,
    } satisfies ImageUploadPlaceholderMeta)
    .insertContentAt(range, content)
    .run()
}

function findImageUploadPlaceholderRange(editor: Editor, id: string) {
  if (!isEditorUsable(editor)) {
    return null
  }

  const placeholder = imageUploadPlaceholderPluginKey
    .getState(editor.state)
    ?.placeholders
    .find(item => item.id === id)

  if (!placeholder) {
    return null
  }

  return {
    from: placeholder.from,
    to: Math.max(placeholder.from, placeholder.to),
  }
}

function isEditorUsable(editor: Editor) {
  return !editor.isDestroyed && Boolean(editor.view)
}

function createPlaceholderRecord(
  id: string,
  from: number,
  to: number,
  files: readonly File[],
): ImageUploadPlaceholderRecord {
  return {
    id,
    from,
    to,
    label: files.length > 1
      ? translate('editor.upload.uploadingImages', { count: files.length })
      : translate('editor.upload.uploadingImage'),
    detail: files.length > 1
      ? files.map(file => prettyBytes(file.size, { precision: 1 })).join(' / ')
      : `${files[0]?.name ?? translate('editor.upload.imageFallback')} · ${prettyBytes(files[0]?.size ?? 0, { precision: 1 })}`,
    previewUrl: files.length === 1 ? createFilePreviewUrl(files[0]) : null,
  }
}

function mapPlaceholder(
  transaction: Transaction,
  placeholder: ImageUploadPlaceholderRecord,
): ImageUploadPlaceholderRecord {
  const from = transaction.mapping.map(placeholder.from, 1)

  return {
    ...placeholder,
    from,
    to: Math.max(from, transaction.mapping.map(placeholder.to, -1)),
  }
}

function createPlaceholderState(
  doc: ProseMirrorNode,
  placeholders: ImageUploadPlaceholderRecord[],
): ImageUploadPlaceholderState {
  return {
    placeholders,
    decorations: DecorationSet.create(
      doc,
      placeholders.map(placeholder => Decoration.widget(
        resolveImageUploadPlaceholderWidgetAt(doc, placeholder.from),
        () => createPlaceholderElement(placeholder),
        {
          destroy: () => revokeImageUploadPreviewUrl(placeholder.previewUrl),
          key: placeholder.id,
          side: 1,
        },
      )),
    ),
  }
}

function resolveImageUploadPlaceholderWidgetAt(doc: ProseMirrorNode, position: number) {
  const resolvedPosition = doc.resolve(Math.min(Math.max(position, 0), doc.content.size))

  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth)

    if (node.isBlock) {
      return resolvedPosition.before(depth)
    }
  }

  return resolvedPosition.pos
}

function createPlaceholderElement(placeholder: ImageUploadPlaceholderRecord) {
  const root = document.createElement('div')
  root.className = [
    'tiptap-image-upload-placeholder',
    placeholder.previewUrl
      ? 'tiptap-image-upload-placeholder--preview'
      : 'tiptap-image-upload-placeholder--fallback',
  ].join(' ')
  root.contentEditable = 'false'
  root.dataset.uploadPlaceholder = 'image'
  root.setAttribute('role', 'status')
  root.setAttribute('aria-label', placeholder.label)

  if (placeholder.previewUrl) {
    const preview = document.createElement('img')
    preview.className = 'tiptap-image-upload-placeholder__preview'
    preview.alt = ''
    preview.decoding = 'async'
    preview.src = placeholder.previewUrl
    preview.addEventListener('load', () => revokeImageUploadPreviewUrl(placeholder.previewUrl), { once: true })
    preview.addEventListener('error', () => revokeImageUploadPreviewUrl(placeholder.previewUrl), { once: true })
    root.append(preview)
  }

  const overlay = document.createElement('div')
  overlay.className = 'tiptap-image-upload-placeholder__overlay'

  const status = document.createElement('div')
  status.className = 'tiptap-image-upload-placeholder__status'

  const indicator = document.createElement('span')
  indicator.className = 'tiptap-image-upload-placeholder__indicator'

  const text = document.createElement('span')
  text.className = 'tiptap-image-upload-placeholder__text'

  const label = document.createElement('span')
  label.className = 'tiptap-image-upload-placeholder__label'
  label.textContent = placeholder.label

  const detail = document.createElement('span')
  detail.className = 'tiptap-image-upload-placeholder__detail'
  detail.textContent = placeholder.detail

  text.append(label, detail)
  status.append(indicator, text)
  overlay.append(status)
  root.append(overlay)

  return root
}

function createFilePreviewUrl(file: File | undefined) {
  if (!file || !file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') {
    return null
  }

  return URL.createObjectURL(file)
}

function revokeImageUploadPreviewUrl(previewUrl: string | null) {
  if (previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(previewUrl)
  }
}
