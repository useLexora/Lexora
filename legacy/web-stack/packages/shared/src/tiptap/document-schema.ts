import type { Extensions } from '@tiptap/core'
import {
  TIPTAP_BODY_BLOCK_ID_ATTRIBUTE,
  TIPTAP_BODY_BLOCK_ID_NODE_TYPES,
  TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE,
  TIPTAP_CODE_BLOCK_TAB_SIZES,
  TIPTAP_DOCUMENT_FILE_NODE_PART,
  TIPTAP_DOCUMENT_FILE_NODE_TYPE,
} from '@haohaoxue/lexora-contracts/tiptap/document-body'
import { Extension, mergeAttributes, Node } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { TextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { prettyBytes } from '../file'
import { createTiptapDocumentBodyLinkOptions } from './document-link'

const TEXT_COLOR_CLASS_PATTERN = /^tiptap-highlight-[a-z-]+-text$/
const BACKGROUND_COLOR_CLASS_PATTERN = /^tiptap-highlight-[a-z-]+-bg$/

/** Tiptap schema 解析所需的 HTML 元素形状。 */
interface HtmlElementLike {
  /** 读取元素属性 */
  getAttribute: (name: string) => string | null
  /** 读取内联样式 */
  style: {
    marginLeft?: string
    marginRight?: string
    textAlign?: string
  }
  /** 读取元素类名 */
  classList?: Iterable<string>
}

export function createTiptapDocumentTitleSchemaExtensions(): Extensions {
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
  ]
}

export function createTiptapDocumentBodySchemaExtensions(): Extensions {
  return [
    createBlockIdSchemaExtension(),
    createCodeBlockSchemaExtension(),
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5],
      },
      link: createTiptapDocumentBodyLinkOptions(),
    }),
    TextStyle,
    createTextColorClassSchemaExtension(),
    createTextAlignSchemaExtension(),
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
    ...createMathSchemaExtensions(),
    createDocumentImageSchemaExtension().configure({
      inline: false,
    }),
    createDocumentFileSchemaExtension(),
  ]
}

function createCodeBlockSchemaExtension() {
  return Extension.create({
    name: 'codeBlockMetadata',

    addGlobalAttributes() {
      return [
        {
          types: ['codeBlock'],
          attributes: {
            name: {
              default: undefined,
              parseHTML: element => normalizeCodeBlockName(element.getAttribute('data-name')),
              renderHTML: (attributes) => {
                const name = normalizeCodeBlockName(attributes.name)

                return name ? { 'data-name': name } : {}
              },
            },
            collapsed: {
              default: undefined,
              parseHTML: element => element.getAttribute('data-collapsed') === 'true' ? true : undefined,
              renderHTML: attributes => attributes.collapsed === true
                ? { 'data-collapsed': 'true' }
                : {},
            },
            tabSize: {
              default: undefined,
              parseHTML: element => normalizeCodeBlockTabSizeAttribute(element.getAttribute('data-tab-size')),
              renderHTML: (attributes) => {
                const tabSize = normalizeCodeBlockTabSizeAttribute(attributes.tabSize)

                return tabSize === undefined ? {} : { 'data-tab-size': String(tabSize) }
              },
            },
          },
        },
      ]
    },
  })
}

function createMathSchemaExtensions() {
  return [
    Node.create({
      name: 'inlineMath',
      group: 'inline',
      inline: true,
      atom: true,

      addAttributes() {
        return {
          latex: {
            default: '',
            parseHTML: element => element.getAttribute('data-latex') ?? '',
            renderHTML: attributes => ({
              'data-latex': attributes.latex,
            }),
          },
        }
      },

      parseHTML() {
        return [
          {
            tag: 'span[data-type="inline-math"]',
          },
        ]
      },

      renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'inline-math' })]
      },
    }),
    Node.create({
      name: 'blockMath',
      group: 'block',
      atom: true,

      addAttributes() {
        return {
          latex: {
            default: '',
            parseHTML: element => element.getAttribute('data-latex') ?? '',
            renderHTML: attributes => ({
              'data-latex': attributes.latex,
            }),
          },
        }
      },

      parseHTML() {
        return [
          {
            tag: 'div[data-type="block-math"]',
          },
        ]
      },

      renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'block-math' })]
      },
    }),
  ]
}

function createBlockIdSchemaExtension() {
  return Extension.create({
    name: 'blockId',

    addGlobalAttributes() {
      return [
        {
          types: [...TIPTAP_BODY_BLOCK_ID_NODE_TYPES],
          attributes: {
            [TIPTAP_BODY_BLOCK_ID_ATTRIBUTE]: {
              default: null,
              parseHTML: element => element.getAttribute('data-block-id'),
              renderHTML: (attributes) => {
                const blockId = attributes[TIPTAP_BODY_BLOCK_ID_ATTRIBUTE]

                if (typeof blockId !== 'string' || !blockId.length) {
                  return {}
                }

                return {
                  'id': blockId,
                  'data-block-id': blockId,
                }
              },
            },
          },
        },
      ]
    },
  })
}

function createDocumentImageSchemaExtension() {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
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
        alt: {
          default: null,
        },
        width: {
          default: null,
        },
        height: {
          default: null,
        },
        textAlign: {
          default: null,
          parseHTML: element => resolveImageTextAlign(element),
          renderHTML: (attributes) => {
            if (!isImageTextAlign(attributes.textAlign)) {
              return {}
            }

            return {
              'data-align': attributes.textAlign,
              'style': resolveImageAlignStyle(attributes.textAlign),
            }
          },
        },
        caption: {
          default: null,
          parseHTML: element => element.getAttribute('data-caption'),
          renderHTML: (attributes) => {
            if (typeof attributes.caption !== 'string' || !attributes.caption.length) {
              return {}
            }

            return {
              'data-caption': attributes.caption,
            }
          },
        },
        src: {
          default: null,
        },
      }
    },

    parseHTML() {
      return [
        {
          tag: 'img[data-asset-id]',
        },
      ]
    },
  })
}

function createDocumentFileSchemaExtension() {
  return Node.create({
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
        : '未命名附件'
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
        ['div', { 'data-part': TIPTAP_DOCUMENT_FILE_NODE_PART.META }, metaParts.join(' · ') || '附件'],
      ]
    },
  })
}

function createTextAlignSchemaExtension() {
  return Extension.create({
    name: 'textAlign',

    addGlobalAttributes() {
      return [
        {
          types: ['paragraph', 'heading'],
          attributes: {
            textAlign: {
              default: undefined,
              parseHTML: (element) => {
                const textAlign = element.style.textAlign

                return isTextAlignValue(textAlign) ? textAlign : undefined
              },
              renderHTML: (attributes) => {
                if (!isTextAlignValue(attributes.textAlign)) {
                  return {}
                }

                return {
                  style: `text-align: ${attributes.textAlign}`,
                }
              },
            },
          },
        },
      ]
    },
  })
}

function createTextColorClassSchemaExtension() {
  return Extension.create({
    name: 'textColorClass',

    addGlobalAttributes() {
      return [
        {
          types: ['textStyle'],
          attributes: {
            textColorClass: {
              default: null,
              parseHTML: element => findMatchingClassName(element, TEXT_COLOR_CLASS_PATTERN),
              renderHTML: attributes => renderClassName(attributes.textColorClass),
            },
            backgroundColorClass: {
              default: null,
              parseHTML: element => findMatchingClassName(element, BACKGROUND_COLOR_CLASS_PATTERN),
              renderHTML: attributes => renderClassName(attributes.backgroundColorClass),
            },
          },
        },
      ]
    },
  })
}

function resolveImageTextAlign(element: HtmlElementLike) {
  const textAlign = element.getAttribute('data-align')

  if (isImageTextAlign(textAlign)) {
    return textAlign
  }

  const marginLeft = element.style.marginLeft
  const marginRight = element.style.marginRight

  if (marginLeft === 'auto' && marginRight === 'auto') {
    return 'center'
  }

  if (marginLeft === 'auto') {
    return 'right'
  }

  return undefined
}

function resolveImageAlignStyle(value: 'left' | 'center' | 'right') {
  switch (value) {
    case 'center':
      return 'display: block; margin-left: auto; margin-right: auto;'
    case 'right':
      return 'display: block; margin-left: auto; margin-right: 0;'
    default:
      return 'display: block; margin-left: 0; margin-right: auto;'
  }
}

function isImageTextAlign(value: unknown): value is 'left' | 'center' | 'right' {
  return value === 'left' || value === 'center' || value === 'right'
}

function isTextAlignValue(value: unknown): value is 'left' | 'center' | 'right' {
  return value === 'left' || value === 'center' || value === 'right'
}

function normalizeCodeBlockName(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()

  return normalized || undefined
}

function normalizeCodeBlockTabSizeAttribute(value: unknown) {
  const tabSize = normalizeCodeBlockTabSize(value)

  return tabSize === TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE ? undefined : tabSize
}

function normalizeCodeBlockTabSize(value: unknown) {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE

  return TIPTAP_CODE_BLOCK_TAB_SIZES.includes(numberValue as typeof TIPTAP_CODE_BLOCK_TAB_SIZES[number])
    ? numberValue
    : TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE
}

function findMatchingClassName(element: HtmlElementLike, pattern: RegExp) {
  return Array.from(element.classList ?? []).find(className => pattern.test(className)) ?? null
}

function renderClassName(className: unknown) {
  if (typeof className !== 'string' || !className) {
    return {}
  }

  return {
    class: className,
  }
}
