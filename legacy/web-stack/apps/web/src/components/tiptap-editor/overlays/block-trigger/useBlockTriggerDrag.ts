import type { Editor } from '@tiptap/core'
import type { ComputedRef, ShallowRef } from 'vue'
import type { BlockDropTarget } from './blockTriggerDragProjector'
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import { moveCurrentBlockTo } from '../../commands/editorActions'
import {
  isPointInsideEditor,
  projectBlockDropTarget,
  resolveBlockDragSource,
} from './blockTriggerDragProjector'
import { createBlockDragPreviewElement, setBlockDragViewLock } from './blockTriggerDragView'

const BLOCK_DRAG_DATA_TYPE = 'application/x-lexora-block-id'

/** 块触发拖拽控制器。 */
export interface BlockTriggerDragController {
  /** 是否正在拖拽 */
  isDragging: ShallowRef<boolean>
  /** 辅助线样式 */
  dropIndicatorStyle: ComputedRef<Record<string, string> | undefined>
  /** 开始拖拽 */
  handleDragStart: (event: DragEvent) => void
  /** 结束拖拽 */
  handleDragEnd: () => void
}

export function useBlockTriggerDrag(options: {
  editor: Editor
  canDrag: ComputedRef<boolean>
  closeMenu: () => void
}): BlockTriggerDragController {
  const isDragging = shallowRef(false)
  const sourceBlockId = shallowRef<string | null>(null)
  const sourceElement = shallowRef<HTMLElement | null>(null)
  const dragPreviewElement = shallowRef<HTMLElement | null>(null)
  const dropTarget = shallowRef<BlockDropTarget | null>(null)

  const dropIndicatorStyle = computed(() => {
    if (!dropTarget.value) {
      return undefined
    }

    return {
      left: `${dropTarget.value.left}px`,
      top: `${dropTarget.value.top - 1}px`,
      width: `${dropTarget.value.width}px`,
    }
  })

  onBeforeUnmount(handleDragEnd)

  return {
    isDragging,
    dropIndicatorStyle,
    handleDragStart,
    handleDragEnd,
  }

  function handleDragStart(event: DragEvent) {
    if (!options.canDrag.value) {
      event.preventDefault()
      return
    }

    const dragSource = resolveBlockDragSource(options.editor)

    if (!dragSource) {
      event.preventDefault()
      return
    }

    sourceBlockId.value = dragSource.blockId
    sourceElement.value = dragSource.element
    setDraggingSourceAttribute(dragSource.element, true)
    setBlockDragViewLock(options.editor, true)
    isDragging.value = true
    dropTarget.value = null
    options.closeMenu()
    bindDocumentListeners()

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(BLOCK_DRAG_DATA_TYPE, dragSource.blockId)

      dragPreviewElement.value = createBlockDragPreviewElement(dragSource.previewText)
      const previewRect = dragPreviewElement.value.getBoundingClientRect()
      event.dataTransfer.setDragImage(
        dragPreviewElement.value,
        Math.min(previewRect.width / 2, 64),
        previewRect.height + 14,
      )
    }
  }

  function handleDragEnd() {
    unbindDocumentListeners()

    if (sourceElement.value) {
      setDraggingSourceAttribute(sourceElement.value, false)
    }

    setBlockDragViewLock(options.editor, false)
    dragPreviewElement.value?.remove()

    isDragging.value = false
    sourceBlockId.value = null
    sourceElement.value = null
    dragPreviewElement.value = null
    dropTarget.value = null
  }

  function handleDocumentDragOver(event: DragEvent) {
    if (!isDragging.value || !sourceBlockId.value) {
      return
    }

    if (!isPointInsideEditor(options.editor, event.clientX, event.clientY)) {
      dropTarget.value = null
      return
    }

    event.preventDefault()

    const nextDropTarget = projectBlockDropTarget(
      options.editor,
      sourceBlockId.value,
      event.clientX,
      event.clientY,
    )

    dropTarget.value = nextDropTarget

    if (!nextDropTarget) {
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none'
      }
      return
    }

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
  }

  function handleDocumentDrop(event: DragEvent) {
    if (!isDragging.value || !sourceBlockId.value) {
      return
    }

    if (!isPointInsideEditor(options.editor, event.clientX, event.clientY)) {
      handleDragEnd()
      return
    }

    event.preventDefault()

    const nextDropTarget = projectBlockDropTarget(
      options.editor,
      sourceBlockId.value,
      event.clientX,
      event.clientY,
    )

    if (nextDropTarget) {
      moveCurrentBlockTo(options.editor, nextDropTarget.blockId, nextDropTarget.placement)
    }

    handleDragEnd()
  }

  function bindDocumentListeners() {
    document.addEventListener('dragover', handleDocumentDragOver)
    document.addEventListener('drop', handleDocumentDrop)
  }

  function unbindDocumentListeners() {
    document.removeEventListener('dragover', handleDocumentDragOver)
    document.removeEventListener('drop', handleDocumentDrop)
  }
}

function setDraggingSourceAttribute(element: HTMLElement, isDragging: boolean) {
  if (isDragging) {
    element.dataset.tiptapDragSource = 'true'
    return
  }

  delete element.dataset.tiptapDragSource
}
