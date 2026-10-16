import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { BodyBlockIdNodeType } from '../content/blockId'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import {
  BODY_BLOCK_ID_ATTRIBUTE,
  BODY_BLOCK_ID_NODE_TYPES,

  createBlockId,
  isAddressableBodyBlock,
  isBlockId,
  isBodyBlockIdNodeTypeName,
} from '../content/blockId'

const BLOCK_ID_TRANSACTION_META = 'lexoraBlockIdTransaction'

/**
 * blockId 扩展配置。
 */
export interface BlockIdOptions {
  attributeName: string
  dataAttributeName: string
  types: string[]
  generateId: (nodeType: BodyBlockIdNodeType) => string
}

export const BlockId = Extension.create<BlockIdOptions>({
  name: 'blockId',

  addOptions() {
    return {
      attributeName: BODY_BLOCK_ID_ATTRIBUTE,
      dataAttributeName: 'data-block-id',
      types: [...BODY_BLOCK_ID_NODE_TYPES],
      generateId: createBlockId,
    }
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          [this.options.attributeName]: {
            default: null,
            parseHTML: element => element.getAttribute(this.options.dataAttributeName),
            renderHTML: (attributes) => {
              const blockId = attributes[this.options.attributeName]

              if (typeof blockId !== 'string' || !blockId.length) {
                return {}
              }

              return {
                id: blockId,
                [this.options.dataAttributeName]: blockId,
              }
            },
          },
        },
      },
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(this.name),
        appendTransaction: (transactions, _, newState) => {
          const changedTransactions = transactions.filter(transaction =>
            transaction.docChanged
            && !transaction.getMeta(BLOCK_ID_TRANSACTION_META),
          )

          if (changedTransactions.length === 0) {
            return
          }

          return createBlockIdTransaction(newState, this.options, {
            addToHistory: shouldAddBlockIdTransactionToHistory(changedTransactions),
          }) ?? undefined
        },
      }),
    ]
  },

  onCreate() {
    const transaction = createBlockIdTransaction(this.editor.state, this.options, {
      addToHistory: false,
    })

    if (!transaction) {
      return
    }

    this.editor.view.dispatch(transaction)
  },
})

function createBlockIdTransaction(
  state: EditorState,
  options: BlockIdOptions,
  transactionOptions: {
    addToHistory: boolean
  },
): Transaction | null {
  const seenIds = new Set<string>()
  let transaction = state.tr
  let changed = false

  state.doc.descendants((node, pos, parent) => {
    if (!isConfigurableBlockIdNode(node, options.types)) {
      return
    }

    const blockId = readBlockId(node, options.attributeName)

    if (!isAddressableBodyBlock(node, parent)) {
      if (!blockId) {
        return
      }

      transaction = transaction.setNodeMarkup(
        pos,
        undefined,
        {
          ...node.attrs,
          [options.attributeName]: null,
        },
        node.marks,
      )
      changed = true
      return
    }

    if (blockId && !seenIds.has(blockId)) {
      seenIds.add(blockId)
      return
    }

    const nextId = generateUniqueBlockId(node.type.name, seenIds, options.generateId)

    seenIds.add(nextId)
    transaction = transaction.setNodeMarkup(
      pos,
      undefined,
      {
        ...node.attrs,
        [options.attributeName]: nextId,
      },
      node.marks,
    )
    changed = true
  })

  if (!changed) {
    return null
  }

  transaction = transaction.setMeta(BLOCK_ID_TRANSACTION_META, true)

  if (!transactionOptions.addToHistory) {
    transaction = transaction.setMeta('addToHistory', false)
  }

  return transaction
}

function shouldAddBlockIdTransactionToHistory(transactions: readonly Transaction[]) {
  return transactions.some(transaction => transaction.getMeta('addToHistory') !== false)
}

function isConfigurableBlockIdNode(node: ProseMirrorNode, types: string[]): node is ProseMirrorNode & { type: { name: BodyBlockIdNodeType } } {
  return node.type.name !== 'doc'
    && node.isBlock
    && types.includes(node.type.name)
    && isBodyBlockIdNodeTypeName(node.type.name)
}

function readBlockId(node: ProseMirrorNode, attributeName: string) {
  const blockId = node.attrs[attributeName]

  if (!isBlockId(blockId)) {
    return null
  }

  return blockId
}

function generateUniqueBlockId(
  nodeType: BodyBlockIdNodeType,
  seenIds: Set<string>,
  generateId: (nodeType: BodyBlockIdNodeType) => string,
) {
  let blockId = generateId(nodeType)

  while (!blockId || seenIds.has(blockId)) {
    blockId = generateId(nodeType)
  }

  return blockId
}
