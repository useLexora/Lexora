import type { Editor } from '@tiptap/core'
import type { EditorDocumentRange } from './editorRange'
import { posToDOMRect } from '@tiptap/core'

export interface EditorRangeReferenceRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
  x: number
  y: number
  toJSON: () => Omit<EditorRangeReferenceRect, 'toJSON'>
}

export type EditorRangeReferenceRectData = Omit<EditorRangeReferenceRect, 'toJSON'>

export interface EditorRangeReferenceElement {
  getBoundingClientRect: () => EditorRangeReferenceRect
  getClientRects: () => EditorRangeReferenceRect[]
}

export interface EditorRangeReferenceAnchor {
  range: EditorDocumentRange
  rect: EditorRangeReferenceRect
  startRect: EditorRangeReferenceRect | null
}

export function createEditorRangeReferenceAnchor(
  editor: Editor,
  range: EditorDocumentRange,
): EditorRangeReferenceAnchor | null {
  const rect = getEditorRangeReferenceRect(editor, range)

  if (!rect) {
    return null
  }

  return {
    range,
    rect,
    startRect: getEditorPositionReferenceRect(editor, range.from),
  }
}

export function createEditorRangeReferenceElement(
  editor: Editor,
  anchor: EditorRangeReferenceAnchor,
): EditorRangeReferenceElement {
  return {
    getBoundingClientRect: () => getCurrentEditorRangeReferenceRect(editor, anchor),
    getClientRects: () => [getCurrentEditorRangeReferenceRect(editor, anchor)],
  }
}

export function getCurrentEditorRangeReferenceRect(
  editor: Editor,
  anchor: EditorRangeReferenceAnchor,
): EditorRangeReferenceRect {
  const currentStartRect = anchor.startRect
    ? getEditorPositionReferenceRect(editor, anchor.range.from)
    : null

  return resolveEditorRangeReferenceRect(anchor, currentStartRect)
}

export function resolveEditorRangeReferenceRect(
  anchor: EditorRangeReferenceAnchor,
  currentStartRect: EditorRangeReferenceRect | null,
): EditorRangeReferenceRect {
  if (!currentStartRect || !anchor.startRect) {
    return anchor.rect
  }

  return shiftEditorRangeReferenceRect(anchor.rect, {
    left: currentStartRect.left - anchor.startRect.left,
    top: currentStartRect.top - anchor.startRect.top,
  })
}

export function createEditorRangeReferenceRectSnapshot(
  rect: EditorRangeReferenceRectData,
): EditorRangeReferenceRect {
  const data = {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  }

  return {
    ...data,
    toJSON: () => data,
  }
}

function getEditorRangeReferenceRect(editor: Editor, range: EditorDocumentRange): EditorRangeReferenceRect | null {
  const view = editor.view

  if (!view || typeof view.coordsAtPos !== 'function' || range.to < range.from) {
    return null
  }

  try {
    return createEditorRangeReferenceRectSnapshot(posToDOMRect(view, range.from, range.to))
  }
  catch {
    return null
  }
}

function getEditorPositionReferenceRect(editor: Editor, position: number): EditorRangeReferenceRect | null {
  const view = editor.view

  if (!view || typeof view.coordsAtPos !== 'function' || position > editor.state.doc.content.size) {
    return null
  }

  try {
    const rect = view.coordsAtPos(position)

    return createEditorRangeReferenceRectSnapshot({
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.right - rect.left,
      x: rect.left,
      y: rect.top,
    })
  }
  catch {
    return null
  }
}

function shiftEditorRangeReferenceRect(
  rect: EditorRangeReferenceRect,
  delta: { left: number, top: number },
): EditorRangeReferenceRect {
  return createEditorRangeReferenceRectSnapshot({
    bottom: rect.bottom + delta.top,
    height: rect.height,
    left: rect.left + delta.left,
    right: rect.right + delta.left,
    top: rect.top + delta.top,
    width: rect.width,
    x: rect.x + delta.left,
    y: rect.y + delta.top,
  })
}
