import type { Editor } from '@tiptap/core'

const EDITOR_DRAG_LOCK_ATTRIBUTE = 'data-tiptap-local-block-dragging'
const BODY_DRAG_LOCK_ATTRIBUTE = 'data-tiptap-local-block-dragging'

export function createBlockDragPreviewElement(text: string) {
  const element = document.createElement('div')

  element.className = 'tiptap-block-trigger-drag-preview'
  element.textContent = text
  document.body.appendChild(element)

  return element
}

export function setBlockDragViewLock(editor: Editor, isLocked: boolean) {
  const editorDom = getEditorDomSafely(editor)

  if (editorDom instanceof HTMLElement) {
    toggleDataAttribute(editorDom, EDITOR_DRAG_LOCK_ATTRIBUTE, isLocked)
  }

  toggleDataAttribute(document.body, BODY_DRAG_LOCK_ATTRIBUTE, isLocked)
}

function toggleDataAttribute(element: HTMLElement, attributeName: string, isEnabled: boolean) {
  if (isEnabled) {
    element.setAttribute(attributeName, 'true')
    return
  }

  element.removeAttribute(attributeName)
}

function getEditorDomSafely(editor: Editor) {
  try {
    return editor.view?.dom ?? null
  }
  catch {
    return null
  }
}
