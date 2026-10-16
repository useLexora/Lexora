import {
  TIPTAP_DOCUMENT_FILE_NODE_PART,
  TIPTAP_DOCUMENT_FILE_NODE_TYPE,
} from '@haohaoxue/lexora-contracts/tiptap/document-body'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { mergeAttributes, Node } from '@tiptap/core'
import { translate } from '@/i18n'

export const DocumentFile = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: element => element.getAttribute('data-asset-id'),
        renderHTML: (attributes) => {
          if (typeof attributes.assetId !== 'string' || !attributes.assetId.length) {
            return {}
          }

          return {
            'data-asset-id': attributes.assetId,
          }
        },
      },
      fileName: {
        default: null,
        parseHTML: element => element.getAttribute('data-file-name'),
        renderHTML: (attributes) => {
          if (typeof attributes.fileName !== 'string' || !attributes.fileName.length) {
            return {}
          }

          return {
            'data-file-name': attributes.fileName,
          }
        },
      },
      mimeType: {
        default: null,
        parseHTML: element => element.getAttribute('data-mime-type'),
        renderHTML: (attributes) => {
          if (typeof attributes.mimeType !== 'string' || !attributes.mimeType.length) {
            return {}
          }

          return {
            'data-mime-type': attributes.mimeType,
          }
        },
      },
      size: {
        default: null,
        parseHTML: (element) => {
          const size = Number(element.getAttribute('data-size'))
          return Number.isFinite(size) ? size : null
        },
        renderHTML: (attributes) => {
          if (typeof attributes.size !== 'number') {
            return {}
          }

          return {
            'data-size': String(attributes.size),
          }
        },
      },
      contentUrl: {
        default: null,
        parseHTML: element => element.getAttribute('data-content-url'),
        renderHTML: (attributes) => {
          if (typeof attributes.contentUrl !== 'string' || !attributes.contentUrl.length) {
            return {}
          }

          return {
            'data-content-url': attributes.contentUrl,
          }
        },
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${TIPTAP_DOCUMENT_FILE_NODE_TYPE}"][data-asset-id]`,
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const fileName = typeof node.attrs.fileName === 'string' && node.attrs.fileName.length
      ? node.attrs.fileName
      : translate('editor.common.unnamedAttachment')
    const metaParts = [
      typeof node.attrs.mimeType === 'string' && node.attrs.mimeType.length
        ? node.attrs.mimeType
        : null,
      typeof node.attrs.size === 'number'
        ? prettyBytes(node.attrs.size, { precision: 1 })
        : null,
    ].filter(Boolean)

    return [
      'div',
      mergeAttributes({
        'data-type': TIPTAP_DOCUMENT_FILE_NODE_TYPE,
        'contenteditable': 'false',
      }, HTMLAttributes),
      ['div', { 'data-part': TIPTAP_DOCUMENT_FILE_NODE_PART.TITLE }, fileName],
      ['div', { 'data-part': TIPTAP_DOCUMENT_FILE_NODE_PART.META }, metaParts.join(' · ') || translate('editor.common.attachment')],
    ]
  },
})
