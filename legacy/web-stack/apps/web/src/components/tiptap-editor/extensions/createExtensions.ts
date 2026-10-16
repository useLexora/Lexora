import type { Editor, Extensions } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type {
  TiptapEditorResolveImageSrc,
  TiptapEditorUploadedFile,
  TiptapEditorUploadedImage,
} from '../content/typing'
import type { DocumentAiDraftPreviewOptions } from '../extensions/DocumentAiDraftPreview'
import { createTiptapDocumentBodyLinkOptions } from '@haohaoxue/lexora-shared/tiptap'
import { isNodeEmpty } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { TextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { translate } from '@/i18n'
import { BlockCommands } from '../extensions/BlockCommands'
import { BlockId } from '../extensions/BlockId'
import { CodeBlock } from '../extensions/CodeBlock'
import { DocumentAiDraftPreview } from '../extensions/DocumentAiDraftPreview'
import { DocumentFile } from '../extensions/DocumentFile'
import { DocumentImage } from '../extensions/DocumentImage'
import { HistorySelection } from '../extensions/HistorySelection'
import { ImageUploadPlaceholder } from '../extensions/ImageUploadPlaceholder'
import { InlineCode } from '../extensions/InlineCode'
import { LinkBoundary } from '../extensions/LinkBoundary'
import { LinkClickOpen } from '../extensions/LinkClickOpen'
import { BlockMathematics, InlineMathematics } from '../extensions/Mathematics'
import { PanelSelectionHighlight } from '../extensions/PanelSelectionHighlight'
import { PastePipeline } from '../extensions/PastePipeline'
import { SelectionVisibility } from '../extensions/SelectionVisibility'
import { TextAlign } from '../extensions/TextAlign'
import { TextColorClass } from '../extensions/TextColorClass'

interface CreateBodyExtensionsOptions {
  uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
  uploadFile?: (file: File) => Promise<TiptapEditorUploadedFile>
  resolveImageSrc?: TiptapEditorResolveImageSrc
  placeholder?: string
  emptyLinePlaceholder?: string
  blockIds?: boolean
  aiDraftPreview?: DocumentAiDraftPreviewOptions
}

export function createBodyExtensions(options: CreateBodyExtensionsOptions = {}): Extensions {
  const blockIdentityExtensions = options.blockIds === false
    ? []
    : [
        BlockId,
      ]

  return [
    ...blockIdentityExtensions,
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5],
      },
      link: createTiptapDocumentBodyLinkOptions(),
      code: false,
      codeBlock: false,
    }),
    HistorySelection,
    LinkClickOpen,
    Placeholder.configure({
      placeholder: ({ editor, node }) => resolveBodyPlaceholder(editor, node, options),
    }),
    TextStyle,
    TextColorClass,
    TextAlign,
    InlineCode,
    LinkBoundary,
    PanelSelectionHighlight,
    DocumentAiDraftPreview.configure(options.aiDraftPreview),
    CodeBlock,
    InlineMathematics,
    BlockMathematics,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    DocumentImage.configure({
      inline: false,
      resolveImageSrc: options.resolveImageSrc,
    }),
    ImageUploadPlaceholder,
    DocumentFile,
    BlockCommands,
    PastePipeline.configure({
      uploadImage: options.uploadImage,
      uploadFile: options.uploadFile,
    }),
    SelectionVisibility,
  ]
}

function resolveBodyPlaceholder(
  editor: Editor,
  node: ProseMirrorNode,
  options: CreateBodyExtensionsOptions,
) {
  if (node.type.name === 'heading') {
    return resolveHeadingPlaceholder(node.attrs?.level)
  }

  if (node.type.name !== 'paragraph') {
    return ''
  }

  if (isOnlyEmptyParagraphDocument(editor)) {
    return options.placeholder ?? translate('editor.placeholders.body')
  }

  return options.emptyLinePlaceholder ?? translate('editor.placeholders.emptyLine')
}

function resolveHeadingPlaceholder(level: unknown) {
  if (typeof level === 'number' && Number.isInteger(level) && level > 0) {
    return translate('editor.placeholders.headingLevel', { level })
  }

  return translate('editor.placeholders.heading')
}

function isOnlyEmptyParagraphDocument(editor: Editor) {
  const firstChild = editor.state.doc.firstChild

  return editor.state.doc.childCount === 1
    && firstChild?.type.name === 'paragraph'
    && isNodeEmpty(firstChild)
}

export function createTitleExtensions(): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      hardBreak: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      strike: false,
    }),
    HistorySelection,
    Placeholder.configure({
      placeholder: translate('editor.placeholders.title'),
    }),
  ]
}
