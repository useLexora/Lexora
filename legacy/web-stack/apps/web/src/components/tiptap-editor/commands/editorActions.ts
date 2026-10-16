import type { ChainedCommands, Editor } from '@tiptap/core'
import type { TurnIntoBlockType } from './turnInto'

type TextAlignValue = 'left' | 'center' | 'right'
type InlineMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code'
type InlineSelectionMark = InlineMark | 'link'
export type EditorBlockPlacement = 'before' | 'after'

interface SelectedImageNode {
  attrs?: {
    alt?: unknown
    textAlign?: unknown
  }
}

type ChainedCommandBuilder = (chain: ChainedCommands) => ChainedCommands

/** 编辑器选区范围 */
export interface EditorSelectionRange {
  from: number
  to: number
}

export function toggleInlineMark(editor: Editor, mark: InlineMark) {
  runEditorCommand(editor, (chain) => {
    switch (mark) {
      case 'bold':
        return chain.toggleBold()
      case 'italic':
        return chain.toggleItalic()
      case 'underline':
        return chain.toggleUnderline()
      case 'strike':
        return chain.toggleStrike()
      case 'code':
        return chain.toggleCode()
    }
  })
}

export function turnIntoBlock(editor: Editor, target: TurnIntoBlockType) {
  runEditorCommand(editor, chain => chain.turnIntoBlock(target))
}

export function getCurrentTextAlign(editor: Editor): TextAlignValue {
  const selectedImage = getSelectedImageNode(editor)

  if (selectedImage) {
    const textAlign = selectedImage.attrs?.textAlign
    return textAlign === 'center' || textAlign === 'right' ? textAlign : 'left'
  }

  const textAlign = editor.state.selection.$from.parent.attrs?.textAlign

  return textAlign === 'center' || textAlign === 'right' ? textAlign : 'left'
}

export function applyTextAlign(editor: Editor, value: TextAlignValue) {
  if (isImageSelection(editor)) {
    runEditorCommand(editor, chain => chain.updateAttributes('image', { textAlign: value }))
    return
  }

  runEditorCommand(editor, chain => chain.setTextAlign(value))
}

export function isImageSelection(editor: Editor) {
  return Boolean(getSelectedImageNode(editor) || editor.isActive('image'))
}

export function getCurrentImageAlt(editor: Editor): string {
  const selectedImage = getSelectedImageNode(editor)

  if (selectedImage) {
    return typeof selectedImage.attrs?.alt === 'string' ? selectedImage.attrs.alt : ''
  }

  const alt = editor.getAttributes('image').alt

  return typeof alt === 'string' ? alt : ''
}

export function updateCurrentImageAlt(editor: Editor, alt: string) {
  const trimmedAlt = alt.trim()

  runEditorCommand(editor, chain => chain.updateAttributes('image', {
    alt: trimmedAlt || null,
  }))
}

export function applyTextColor(editor: Editor, color: string, range?: EditorSelectionRange) {
  runEditorCommand(editor, (chain) => {
    const selectionChain = resolveSelectionChain(chain, range)

    if (!color) {
      return selectionChain.unsetTextColorClass()
    }

    return selectionChain.setTextColorClass(color)
  })
}

export function applyHighlightColor(editor: Editor, color: string, range?: EditorSelectionRange) {
  runEditorCommand(editor, (chain) => {
    const selectionChain = resolveSelectionChain(chain, range)

    if (!color) {
      return selectionChain.unsetHighlightClass()
    }

    return selectionChain.setHighlightClass(color)
  })
}

export function isInlineSelectionMarkFullyActive(editor: Editor, mark: InlineSelectionMark) {
  const uniformMarkState = getUniformSelectedTextMarkValue(
    editor,
    marks => marks.some(item => item.type?.name === mark),
    () => editor.isActive(mark),
  )

  return uniformMarkState === true
}

export function getCurrentTextColorClass(editor: Editor) {
  return getUniformSelectedTextMarkValue(
    editor,
    marks => readMarkStringAttribute(marks, 'textStyle', 'textColorClass'),
    () => readEditorAttribute(editor, 'textStyle', 'textColorClass'),
  ) ?? ''
}

export function getCurrentHighlightClass(editor: Editor) {
  return getUniformSelectedTextMarkValue(
    editor,
    marks => readMarkStringAttribute(marks, 'textStyle', 'backgroundColorClass'),
    () => readEditorAttribute(editor, 'textStyle', 'backgroundColorClass'),
  ) ?? ''
}

export function canIndentBlock(editor: Editor) {
  return canRunEditorCommand(editor, chain => chain.indentBlock())
}

export function canOutdentBlock(editor: Editor) {
  return canRunEditorCommand(editor, chain => chain.outdentBlock())
}

export function indentBlock(editor: Editor) {
  if (!canIndentBlock(editor)) {
    return
  }

  runEditorCommand(editor, chain => chain.indentBlock())
}

export function outdentBlock(editor: Editor) {
  if (!canOutdentBlock(editor)) {
    return
  }

  runEditorCommand(editor, chain => chain.outdentBlock())
}

export function deleteCurrentBlock(editor: Editor) {
  runEditorCommand(editor, chain => chain.deleteBlock())
}

export function moveCurrentBlockTo(editor: Editor, targetBlockId: string, placement: EditorBlockPlacement) {
  runEditorCommand(editor, chain => chain.moveCurrentBlockTo(targetBlockId, placement))
}

export function insertEditorContent(editor: Editor, content: Parameters<ChainedCommands['insertContent']>[0]) {
  runEditorCommand(editor, chain => chain.insertContent(content))
}

function runEditorCommand(editor: Editor, build: ChainedCommandBuilder) {
  build(editor.chain().focus()).run()
}

function canRunEditorCommand(editor: Editor, build: ChainedCommandBuilder) {
  if (typeof editor.can !== 'function') {
    return false
  }

  return build(editor.can().chain().focus()).run()
}

function resolveSelectionChain(chain: ChainedCommands, range?: EditorSelectionRange) {
  if (!range) {
    return chain
  }

  return chain.setTextSelection(range)
}

function getSelectedImageNode(editor: Editor): SelectedImageNode | null {
  const selection = editor.state.selection as { node?: { type?: { name?: string }, attrs?: SelectedImageNode['attrs'] } }

  if (selection.node?.type?.name === 'image') {
    return selection.node
  }

  return null
}

function getUniformSelectedTextMarkValue<T>(
  editor: Editor,
  readValue: (marks: readonly EditorMarkLike[]) => T,
  readFallbackValue: () => T,
) {
  const selection = editor.state.selection as {
    empty?: boolean
    from: number
    to: number
  }

  if (selection.empty) {
    return readFallbackValue()
  }

  const doc = (editor.state as {
    doc?: {
      nodesBetween?: (from: number, to: number, callback: (node: EditorNodeLike, pos: number) => void | false) => void
    }
  }).doc

  if (typeof doc?.nodesBetween !== 'function') {
    return readFallbackValue()
  }

  let hasText = false
  let currentValue: T | undefined
  let isMixed = false

  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.isText || typeof node.nodeSize !== 'number') {
      return
    }

    const overlapFrom = Math.max(selection.from, pos)
    const overlapTo = Math.min(selection.to, pos + node.nodeSize)

    if (overlapFrom >= overlapTo) {
      return
    }

    const nextValue = readValue(node.marks ?? [])
    hasText = true

    if (currentValue === undefined) {
      currentValue = nextValue
      return
    }

    if (currentValue !== nextValue) {
      isMixed = true
      return false
    }
  })

  if (!hasText || isMixed || currentValue === undefined) {
    return null
  }

  return currentValue
}

function readEditorAttribute(editor: Editor, markName: string, attributeName: string) {
  const value = editor.getAttributes(markName)?.[attributeName]
  return typeof value === 'string' ? value : ''
}

function readMarkStringAttribute(
  marks: readonly EditorMarkLike[],
  markName: string,
  attributeName: string,
) {
  const mark = marks.find(item => item.type?.name === markName)
  const value = mark?.attrs?.[attributeName]

  return typeof value === 'string' ? value : ''
}

interface EditorMarkLike {
  type?: {
    name?: string
  }
  attrs?: Record<string, unknown>
}

interface EditorNodeLike {
  isText?: boolean
  nodeSize?: number
  marks?: readonly EditorMarkLike[]
}
