import type { WorkbenchNode } from '../common/workbench'
import type { WorkbenchController } from '../services/WorkbenchController'
import { onScopeDispose, shallowRef } from 'vue'

export interface WorkbenchSashBoundaries {
  left?: string
  right?: string
  top?: string
  bottom?: string
}

export function useWorkbenchResize(controller: WorkbenchController) {
  const nodes = new Map<string, { element: HTMLElement, node: () => WorkbenchNode }>()
  const hovered = shallowRef<readonly string[]>([])
  const active = shallowRef<readonly string[]>([])
  const cursor = shallowRef('')
  let end: (() => void) | null = null

  function register(id: string, element: HTMLElement, node: () => WorkbenchNode) {
    const entry = { element, node }
    nodes.set(id, entry)
    return () => {
      if (nodes.get(id) !== entry)
        return
      if (active.value.includes(id))
        end?.()
      nodes.delete(id)
    }
  }
  function begin(ids: string[], event: PointerEvent) {
    if (event.button !== 0)
      return
    end?.()
    const snapshots = ids.flatMap((id) => {
      const entry = nodes.get(id)
      const node = entry?.node()
      if (!entry || node?.kind !== 'split')
        return []
      const rect = entry.element.getBoundingClientRect()
      return [{ id, axis: node.axis, ratio: node.ratio, size: (node.axis === 'horizontal' ? rect.width : rect.height) - 1 }]
    })
    if (!snapshots.length || snapshots.some(item => item.size <= 0))
      return
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    const listeners = new AbortController()
    const startX = event.clientX
    const startY = event.clientY
    let frame: number | null = null
    let pending: { x: number, y: number } | null = null
    const flush = () => {
      frame = null
      if (!pending)
        return
      const { x, y } = pending
      pending = null
      controller.resizeMany(snapshots.map(item => ({ id: item.id, ratio: item.ratio + (item.axis === 'horizontal' ? x - startX : y - startY) / item.size })))
    }
    active.value = snapshots.map(item => item.id)
    cursor.value = snapshots.length > 1 ? 'all-scroll' : snapshots[0]!.axis === 'horizontal' ? 'col-resize' : 'row-resize'
    target.setPointerCapture(event.pointerId)
    end = () => {
      if (frame !== null)
        cancelAnimationFrame(frame)
      flush()
      listeners.abort()
      if (target.hasPointerCapture(event.pointerId))
        target.releasePointerCapture(event.pointerId)
      active.value = []
      cursor.value = ''
      end = null
    }
    const cancel = () => {
      pending = null
      controller.resizeMany(snapshots.map(item => ({ id: item.id, ratio: item.ratio })))
      end?.()
    }
    window.addEventListener('pointermove', (move) => {
      if (move.pointerId !== event.pointerId)
        return
      pending = { x: move.clientX, y: move.clientY }
      if (frame === null)
        frame = requestAnimationFrame(flush)
    }, { signal: listeners.signal })
    window.addEventListener('pointerup', (up) => {
      if (up.pointerId !== event.pointerId)
        return
      pending = { x: up.clientX, y: up.clientY }
      end?.()
    }, { signal: listeners.signal })
    window.addEventListener('pointercancel', cancelEvent => cancelEvent.pointerId === event.pointerId && cancel(), { signal: listeners.signal })
    target.addEventListener('lostpointercapture', () => end?.(), { signal: listeners.signal })
    window.addEventListener('blur', () => end?.(), { signal: listeners.signal })
    window.addEventListener('keydown', (key) => {
      if (key.key === 'Escape') {
        key.preventDefault()
        key.stopPropagation()
        cancel()
      }
    }, { capture: true, signal: listeners.signal })
  }
  function keyboard(ids: string[], event: KeyboardEvent) {
    const axis = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 'horizontal' : ['ArrowUp', 'ArrowDown'].includes(event.key) ? 'vertical' : null
    if (!axis)
      return
    const changes = ids.flatMap((id) => {
      const node = nodes.get(id)?.node()
      return node?.kind === 'split' && node.axis === axis ? [{ id, ratio: node.ratio + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 0.03 : -0.03) }] : []
    })
    if (changes.length) {
      event.preventDefault()
      controller.resizeMany(changes)
    }
  }
  onScopeDispose(() => end?.())
  return { active, cursor, register, begin, keyboard, hover: (ids: string[]) => hovered.value = ids, highlighted: (id: string) => active.value.includes(id) || hovered.value.includes(id), reset: (ids: string[]) => controller.resizeMany(ids.map(id => ({ id, ratio: 0.5 }))) }
}

export type WorkbenchResize = ReturnType<typeof useWorkbenchResize>
