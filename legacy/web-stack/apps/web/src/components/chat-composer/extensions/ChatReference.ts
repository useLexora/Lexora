import type { Node as ProseMirrorNode, Schema, Slice } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type {
  ChatComposerAttachment,
  ChatReferenceAttrs,
} from '../typing'
import { mergeAttributes, Node } from '@tiptap/core'
import { Fragment, Slice as ProseMirrorSlice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { translate } from '@/i18n'

export const CHAT_REFERENCE_NODE_NAME = 'chatReference'

export interface ChatReferenceCloneResult {
  nodeId: string
  attachment: ChatComposerAttachment
}

export interface ChatReferenceOptions {
  getAttachmentById: (attachmentId: string) => ChatComposerAttachment | null
  cloneAttachment: (attachment: ChatComposerAttachment) => ChatReferenceCloneResult
}

export const ChatReference = Node.create<ChatReferenceOptions>({
  name: CHAT_REFERENCE_NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      getAttachmentById: () => null,
      cloneAttachment: attachment => ({
        nodeId: String(attachment.id),
        attachment,
      }),
    }
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => element.getAttribute('data-id'),
        renderHTML: attributes => renderStringAttribute('data-id', attributes.id),
      },
      attachmentId: {
        default: null,
        parseHTML: element => element.getAttribute('data-attachment-id'),
        renderHTML: attributes => renderStringAttribute('data-attachment-id', attributes.attachmentId),
      },
      label: {
        default: null,
        parseHTML: element => element.getAttribute('data-label') ?? normalizeReferenceText(element.textContent ?? ''),
        renderHTML: attributes => renderStringAttribute('data-label', attributes.label),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="chat-reference"]',
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = readReferenceAttrs(node)
    return [
      'span',
      mergeAttributes({
        'data-type': 'chat-reference',
        'contenteditable': 'false',
        'class': 'chat-reference-node',
      }, HTMLAttributes),
      `@${attrs.label}`,
    ]
  },

  renderText({ node }) {
    return `@${readReferenceAttrs(node).label}`
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          transformPasted: (slice: Slice) =>
            transformPastedChatReferences(this.editor.state, slice, this.options),
        },
      }),
    ]
  },
})

function transformPastedChatReferences(
  state: EditorState,
  slice: Slice,
  options: ChatReferenceOptions,
): Slice {
  return new ProseMirrorSlice(
    transformFragment(state.schema, slice.content, options),
    slice.openStart,
    slice.openEnd,
  )
}

function transformFragment(
  schema: Schema,
  fragment: Fragment,
  options: ChatReferenceOptions,
): Fragment {
  const children: ProseMirrorNode[] = []

  fragment.forEach((node) => {
    if (node.type.name === CHAT_REFERENCE_NODE_NAME) {
      children.push(transformReferenceNode(schema, node, options))
      return
    }

    if (node.content.size > 0) {
      children.push(node.copy(transformFragment(schema, node.content, options)))
      return
    }

    children.push(node)
  })

  return Fragment.fromArray(children)
}

function transformReferenceNode(
  schema: Schema,
  node: ProseMirrorNode,
  options: ChatReferenceOptions,
): ProseMirrorNode {
  const attrs = readReferenceAttrs(node)
  const sourceAttachment = options.getAttachmentById(attrs.attachmentId)

  if (!sourceAttachment) {
    return schema.text(`@${attrs.label}`)
  }

  const cloned = options.cloneAttachment(sourceAttachment)
  return node.type.create({
    id: cloned.nodeId,
    attachmentId: cloned.attachment.id,
    label: cloned.attachment.title,
  })
}

function readReferenceAttrs(node: ProseMirrorNode): ChatReferenceAttrs {
  return {
    id: typeof node.attrs.id === 'string' ? node.attrs.id : '',
    attachmentId: typeof node.attrs.attachmentId === 'string' ? node.attrs.attachmentId : '',
    label: typeof node.attrs.label === 'string' && node.attrs.label.length
      ? node.attrs.label
      : translate('chat.composer.documentFallback'),
  }
}

function renderStringAttribute(name: string, value: unknown) {
  return typeof value === 'string' && value.length
    ? { [name]: value }
    : {}
}

function normalizeReferenceText(value: string) {
  return value.trim().replace(/^@/u, '') || translate('chat.composer.documentFallback')
}
