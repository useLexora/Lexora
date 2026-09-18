import type { Ref } from 'vue'
import type { DesktopTaskPinnedDropPosition } from './taskPinnedItems'
import { useDragDropMonitor, useDraggable, useDroppable } from '@dnd-kit/vue'
import { nextTick } from 'vue'

export function useTaskHistoryDrag(options: {
  id: () => string
  element: Readonly<Ref<HTMLElement | null>>
  handle: Readonly<Ref<HTMLElement | null>>
  data: () => Record<string, unknown>
  type: 'workbench-task' | 'pinned-space'
  disabled?: () => boolean
  reorderable: () => boolean
  reorderTarget: () => boolean
  start: () => void
  end: () => void
  over: (position: DesktopTaskPinnedDropPosition) => void
  drop: (position: DesktopTaskPinnedDropPosition) => void
}) {
  useDraggable({ id: options.id, type: options.type, element: options.element, handle: options.handle, disabled: options.disabled, data: () => ({ ...options.data(), pinned: options.reorderable() }) })
  useDroppable({ id: () => `pin:${options.id()}`, element: options.element, accept: ['workbench-task', 'pinned-space'], disabled: () => !options.reorderTarget() })
  let position: DesktopTaskPinnedDropPosition | null = null
  useDragDropMonitor({
    onDragStart(event) {
      if (event.operation.source?.id === options.id() && options.reorderable())
        options.start()
    },
    onDragMove(event) {
      const bounds = options.element.value?.getBoundingClientRect()
      const { x, y } = event.to ?? event.operation.position.current
      position = bounds && options.reorderTarget() && event.operation.source?.data.pinned && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
        ? y < bounds.top + bounds.height / 2 ? 'before' : 'after'
        : null
      if (position)
        options.over(position)
    },
    onDragEnd(event) {
      if (!event.canceled && position)
        options.drop(position)
      position = null
      if (event.operation.source?.id === options.id())
        void nextTick(options.end)
    },
  })
}
