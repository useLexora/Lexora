import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import type { AgentDocumentAssistantEditIntent } from '@haohaoxue/lexora-contracts/agent'
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import type { ChatComposerDocumentSelectionScope } from '@/components/chat-composer'
import {
  AGENT_DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_MAX_LENGTH,
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
} from '@haohaoxue/lexora-contracts/agent'
import {
  BODY_BLOCK_ID_ATTRIBUTE,
  isAddressableBodyBlock,
} from '@/components/tiptap-editor/content/blockId'
import { mapTiptapRange } from '@/components/tiptap-editor/utils/rangeMapping'
import {
  createDocsSelectionMarkdownSnapshot,
  serializeDocsSelectionSnapshotToMarkdownLike,
} from './docsSelectionSnapshotSerializer'

const UNSUPPORTED_SELECTION_BLOCK_TYPES = new Set([
  'table',
  'image',
  'file',
  'horizontalRule',
  'blockMath',
])
const DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX = '...'
const DOCUMENT_ASSISTANT_ANCHOR_BEFORE_LABEL = '[锚点前文]'
const DOCUMENT_ASSISTANT_ANCHOR_POSITION_LABEL = '[续写位置]'
const DOCUMENT_ASSISTANT_ANCHOR_AFTER_LABEL = '[锚点后文]'
const DOCUMENT_ASSISTANT_ANCHOR_EMPTY_TEXT = '(无)'

export interface DocsSelectionLiveRange {
  from: number
  to: number
}

export interface DocsSelectionSnapshot {
  scope: ChatComposerDocumentSelectionScope
  snapshot: string
  size: number
}

export interface CreateDocsSelectionSnapshotOptions {
  intent?: AgentDocumentAssistantEditIntent | null
}

export interface DocsBlockLiveRange extends DocsSelectionLiveRange {
  blockId: string
}

export function resolveDocsSelectionScope(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): ChatComposerDocumentSelectionScope | null {
  const range = normalizeDocsSelectionRange({ from, to })

  if (!range) {
    return null
  }

  const fromBoundary = resolveSelectionBoundary(doc, range.from)
  const toBoundary = resolveSelectionBoundary(doc, range.to)

  if (!fromBoundary || !toBoundary) {
    return null
  }

  const blockIds = range.from === range.to
    ? [fromBoundary.blockId]
    : collectSelectionBlockIds(doc, range)

  if (!blockIds.length) {
    return null
  }

  return {
    kind: 'selection',
    field: 'body',
    blockIds,
    from: fromBoundary,
    to: toBoundary,
  }
}

export function createDocsSelectionSnapshot(
  editor: Editor,
  range: DocsSelectionLiveRange,
  options: CreateDocsSelectionSnapshotOptions = {},
): DocsSelectionSnapshot | null {
  const normalizedRange = normalizeDocsSelectionRange(range)

  if (!normalizedRange) {
    return null
  }

  const snapshotRange = resolveSnapshotRangeForIntent(normalizedRange, options.intent)
  const scope = resolveDocsSelectionScope(editor.state.doc, snapshotRange.from, snapshotRange.to)

  if (!scope) {
    return null
  }

  const content = snapshotRange.from === snapshotRange.to
    ? null
    : selectionSliceToContent(editor.state.doc, snapshotRange)
  const snapshot = snapshotRange.from === snapshotRange.to
    ? createDocsAnchorMarkdownSnapshot(editor.state.doc, snapshotRange.from)
    : createDocsSelectionMarkdownSnapshot(content ?? [])

  return {
    scope,
    ...snapshot,
  }
}

export function createDocsBlockSnapshot(
  editor: Editor,
  range: DocsBlockLiveRange,
): DocsSelectionSnapshot | null {
  if (!range.blockId || range.to <= range.from) {
    return null
  }

  const resolvedPosition = editor.state.doc.resolve(range.from)
  const node = resolvedPosition.nodeAfter

  if (
    !node
    || !isAddressableBodyBlock(node, resolvedPosition.parent)
    || readBlockId(node) !== range.blockId
    || range.from + node.nodeSize !== range.to
    || isUnsupportedSelectionBlock(node)
  ) {
    return null
  }

  const textLength = node.textContent.length
  const scope: ChatComposerDocumentSelectionScope = {
    kind: 'selection',
    field: 'body',
    blockIds: [range.blockId],
    from: {
      blockId: range.blockId,
      offset: 0,
      position: range.from,
    },
    to: {
      blockId: range.blockId,
      offset: textLength,
      position: range.to,
    },
  }
  const snapshot = createDocsSelectionMarkdownSnapshot(blockNodeToSnapshotContent(node))

  if (!snapshot.snapshot.trim()) {
    return null
  }

  return {
    scope,
    ...snapshot,
  }
}

export function mapDocsSelectionLiveRange(
  range: DocsSelectionLiveRange,
  transaction: Transaction,
): DocsSelectionLiveRange | null {
  if (!transaction.docChanged) {
    return range
  }

  const mappedRange = mapTiptapRange(range, transaction.mapping, {
    allowCollapsed: true,
  })

  if (!mappedRange) {
    return null
  }

  if (range.to > range.from && mappedRange.to <= mappedRange.from) {
    return null
  }

  return mappedRange
}

function collectSelectionBlockIds(
  doc: ProseMirrorNode,
  range: DocsSelectionLiveRange,
): string[] {
  const blockIds: string[] = []
  const seenBlockIds = new Set<string>()
  let invalid = false

  doc.nodesBetween(range.from, range.to, (node, _position, parent) => {
    if (!isAddressableBodyBlock(node, parent)) {
      return
    }

    if (isUnsupportedSelectionBlock(node)) {
      invalid = true
      return false
    }

    const blockId = readBlockId(node)

    if (!blockId) {
      invalid = true
      return false
    }

    if (!seenBlockIds.has(blockId)) {
      blockIds.push(blockId)
      seenBlockIds.add(blockId)
    }
  })

  return invalid ? [] : blockIds
}

function resolveSelectionBoundary(
  doc: ProseMirrorNode,
  position: number,
): ChatComposerDocumentSelectionScope['from'] | null {
  const resolvedPosition = doc.resolve(position)

  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth)
    const parent = resolvedPosition.node(depth - 1)

    if (!isAddressableBodyBlock(node, parent)) {
      continue
    }

    if (isUnsupportedSelectionBlock(node)) {
      return null
    }

    const blockId = readBlockId(node)

    if (!blockId) {
      return null
    }

    const blockStart = resolvedPosition.before(depth)
    const relativeOffset = Math.max(0, position - blockStart - 1)

    return {
      blockId,
      offset: node.textBetween(0, relativeOffset, '\n', '\n').length,
      position,
    }
  }

  return null
}

function selectionSliceToContent(
  doc: ProseMirrorNode,
  range: DocsSelectionLiveRange,
): TiptapJsonContent {
  const json = doc.cut(range.from, range.to).toJSON().content

  return Array.isArray(json) ? json as TiptapJsonContent : []
}

function normalizeDocsSelectionRange(range: DocsSelectionLiveRange): DocsSelectionLiveRange | null {
  const from = Math.min(range.from, range.to)
  const to = Math.max(range.from, range.to)

  if (from > to) {
    return null
  }

  return {
    from,
    to,
  }
}

function resolveSnapshotRangeForIntent(
  range: DocsSelectionLiveRange,
  intent: AgentDocumentAssistantEditIntent | null | undefined,
): DocsSelectionLiveRange {
  if (intent !== AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
    return range
  }

  return {
    from: range.to,
    to: range.to,
  }
}

function createDocsAnchorMarkdownSnapshot(
  doc: ProseMirrorNode,
  position: number,
): Pick<DocsSelectionSnapshot, 'snapshot' | 'size'> {
  const normalizedPosition = clampAnchorPosition(doc, position)
  const beforeMarkdown = serializeDocSliceToMarkdown(doc, 0, normalizedPosition)
  const afterMarkdown = serializeDocSliceToMarkdown(doc, normalizedPosition, doc.content.size)
  const { before, after } = boundAnchorContext({
    before: beforeMarkdown,
    after: afterMarkdown,
  })
  const snapshot = [
    DOCUMENT_ASSISTANT_ANCHOR_BEFORE_LABEL,
    before || DOCUMENT_ASSISTANT_ANCHOR_EMPTY_TEXT,
    DOCUMENT_ASSISTANT_ANCHOR_POSITION_LABEL,
    DOCUMENT_ASSISTANT_ANCHOR_AFTER_LABEL,
    after || DOCUMENT_ASSISTANT_ANCHOR_EMPTY_TEXT,
  ].join('\n')

  return {
    snapshot,
    size: snapshot.length,
  }
}

function clampAnchorPosition(doc: ProseMirrorNode, position: number) {
  return Math.max(0, Math.min(position, doc.content.size))
}

function serializeDocSliceToMarkdown(doc: ProseMirrorNode, from: number, to: number) {
  if (to <= from) {
    return ''
  }

  const json = doc.cut(from, to).toJSON().content
  const content = Array.isArray(json) ? json as TiptapJsonContent : []
  return serializeDocsSelectionSnapshotToMarkdownLike(content).trim()
}

function boundAnchorContext(input: {
  before: string
  after: string
}) {
  const beforeText = input.before.trim()
  const afterText = input.after.trim()
  const overhead = [
    DOCUMENT_ASSISTANT_ANCHOR_BEFORE_LABEL,
    DOCUMENT_ASSISTANT_ANCHOR_POSITION_LABEL,
    DOCUMENT_ASSISTANT_ANCHOR_AFTER_LABEL,
    DOCUMENT_ASSISTANT_ANCHOR_EMPTY_TEXT,
  ].join('\n').length + 8
  const contextBudget = Math.max(0, AGENT_DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_MAX_LENGTH - overhead)
  const halfBudget = Math.floor(contextBudget / 2)
  let beforeBudget = Math.min(beforeText.length, halfBudget)
  const afterBudget = Math.min(afterText.length, contextBudget - beforeBudget)
  beforeBudget = Math.min(beforeText.length, contextBudget - afterBudget)

  return {
    before: truncateStart(beforeText, beforeBudget),
    after: truncateEnd(afterText, afterBudget),
  }
}

function truncateStart(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text
  }

  const retainedLength = Math.max(0, maxLength - DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX.length)
  if (retainedLength === 0) {
    return DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX.slice(0, maxLength)
  }

  return `${DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX}${text.slice(-retainedLength).trimStart()}`
}

function truncateEnd(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text
  }

  const retainedLength = Math.max(0, maxLength - DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX.length)
  if (retainedLength === 0) {
    return DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX.slice(0, maxLength)
  }

  return `${text.slice(0, retainedLength).trimEnd()}${DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_TRUNCATION_PREFIX}`
}

function readBlockId(node: ProseMirrorNode): string | null {
  const blockId = node.attrs[BODY_BLOCK_ID_ATTRIBUTE]

  return typeof blockId === 'string' && blockId.length ? blockId : null
}

function isUnsupportedSelectionBlock(node: ProseMirrorNode) {
  return UNSUPPORTED_SELECTION_BLOCK_TYPES.has(node.type.name)
}

function blockNodeToSnapshotContent(node: ProseMirrorNode): TiptapJsonContent {
  const json = node.toJSON()
  return json ? [json] as TiptapJsonContent : []
}
