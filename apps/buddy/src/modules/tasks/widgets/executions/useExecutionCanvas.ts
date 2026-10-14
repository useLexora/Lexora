import type { Ref } from 'vue'
import type { ExecutionCanvasNode } from '../../model/executions/executionCanvas'
import { Graph } from '@antv/x6'
import { useIntersectionObserver, useResizeObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { conversationCanvasConnection } from '../../model/canvas/conversationCanvasConnections'
import { executionNeedsAttention } from '../../model/executions/executionCanvas'
import { CANVAS_NODE_SHAPE, createCanvasNodeHost } from '../canvas/canvasNodeHost'

export function useExecutionCanvas(container: Readonly<Ref<HTMLElement | null>>, surface: Readonly<Ref<HTMLElement | null>>, nodes: Readonly<Ref<readonly ExecutionCanvasNode[]>>) {
  const host = createCanvasNodeHost()
  const graph = shallowRef<Graph | null>(null)
  const nearby = shallowRef(false)
  const zoom = shallowRef(100)
  const manualPositions = new Map<string, { x: number, y: number }>()
  let applying = false
  let pendingFocus: string | null = null
  const geometry = computed(() => JSON.stringify(nodes.value.map(node => [node.execution.runId, node.parentId, node.x, node.y, node.width, node.height])))
  let viewport: { tx: number, ty: number, scale: number, width: number, height: number } | null = null
  let frame = 0

  function focus(id: string) {
    const value = graph.value
    const node = value?.getCellById(id)
    const element = surface.value
    if (!value || !node || !element?.clientWidth || !element.clientHeight) {
      pendingFocus = id
      return
    }
    const bounds = node.getBBox()
    value.positionPoint(bounds.center, element.clientWidth / 2, element.clientHeight / 2)
    pendingFocus = null
  }

  function place(readable: boolean) {
    const value = graph.value
    const element = surface.value
    if (!value || !element || !nodes.value.length)
      return
    const bounds = value.getContentArea({ useCellGeometry: true })
    const scale = Math.max(readable ? 0.75 : 0.35, Math.min(1, (element.clientWidth - 32) / bounds.width, (element.clientHeight - 32) / bounds.height))
    value.zoomTo(scale)
    const focus = nodes.value.find(node => executionNeedsAttention(node.execution)) ?? nodes.value[1] ?? nodes.value[0]!
    const focusBounds = value.getCellById(focus.execution.runId)!.getBBox()
    const center = {
      x: readable && bounds.width * scale > element.clientWidth - 32 ? focusBounds.center.x : bounds.x + bounds.width / 2,
      y: readable && bounds.height * scale > element.clientHeight - 32 ? focusBounds.center.y : bounds.y + bounds.height / 2,
    }
    value.positionPoint(center, element.clientWidth / 2, element.clientHeight / 2)
  }

  function updateEdge(id: string) {
    const edge = graph.value?.getCellById(id)
    if (!edge?.isEdge())
      return
    const source = edge.getSourceNode()
    const target = edge.getTargetNode()
    if (!source || !target)
      return
    const connection = conversationCanvasConnection(source.getBBox(), target.getBBox(), 'horizontal')
    edge.setSource({ cell: source.id, anchor: 'right', connectionPoint: 'anchor' })
    edge.setTarget({ cell: target.id, anchor: 'left', connectionPoint: 'anchor' })
    edge.setVertices(connection.vertices)
  }

  function sync() {
    frame = 0
    const value = graph.value
    if (!value)
      return
    applying = true
    const desired = new Set<string>()
    value.batchUpdate('executions', () => {
      for (const node of nodes.value) {
        const id = node.execution.runId
        desired.add(id)
        const position = manualPositions.get(id) ?? node
        const cell = value.getCellById(id) ?? value.addNode({ id, shape: CANVAS_NODE_SHAPE, x: position.x, y: position.y, width: node.width, height: node.height, zIndex: 1 })
        if (cell.isNode() && (cell.position().x !== position.x || cell.position().y !== position.y))
          cell.position(position.x, position.y)
      }
      for (const node of nodes.value) {
        if (!node.parentId)
          continue
        const id = `edge:${node.parentId}:${node.execution.runId}`
        desired.add(id)
        if (!value.getCellById(id)) {
          value.addEdge({
            id,
            source: { cell: node.parentId, anchor: 'right' },
            target: { cell: node.execution.runId, anchor: 'left' },
            connector: { name: 'rounded', args: { radius: 12 } },
            attrs: { line: { stroke: 'var(--buddy-border-strong)', strokeWidth: 1.5, targetMarker: { name: 'block', width: 5, height: 4 } } },
            zIndex: 0,
          })
        }
        updateEdge(id)
      }
      for (const cell of value.getCells()) {
        if (!desired.has(cell.id))
          value.removeCell(cell)
      }
    })
    for (const id of manualPositions.keys()) {
      if (!desired.has(id))
        manualPositions.delete(id)
    }
    applying = false
  }

  function release() {
    cancelAnimationFrame(frame)
    frame = 0
    if (graph.value) {
      viewport = { ...graph.value.translate(), scale: graph.value.zoom(), width: graph.value.options.width, height: graph.value.options.height }
      graph.value.dispose()
      graph.value = null
      host.hosts.clear()
    }
  }

  function updateVisibility() {
    const element = surface.value
    if (!nearby.value || !container.value || !element?.clientWidth || !element.clientHeight) {
      release()
      return
    }
    if (graph.value) {
      if (graph.value.options.width !== element.clientWidth || graph.value.options.height !== element.clientHeight) {
        graph.value.resize(element.clientWidth, element.clientHeight)
        place(true)
      }
      return
    }
    const value = new Graph({
      container: container.value!,
      width: element.clientWidth,
      height: element.clientHeight,
      virtual: { enabled: true, margin: 160 },
      createCellView: cell => cell.isNode() ? host.view : undefined,
      background: { color: 'transparent' },
      panning: { enabled: true, eventTypes: ['leftMouseDown', 'mouseWheelDown'] },
      mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], minScale: 0.35, maxScale: 1.5, zoomAtMousePosition: true },
      scaling: { min: 0.35, max: 1.5 },
      preventDefaultMouseDown: false,
      interacting: {
        nodeMovable: true,
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexAddable: false,
        vertexMovable: false,
        vertexDeletable: false,
        magnetConnectable: false,
      },
      connecting: { allowBlank: false, allowLoop: false, allowNode: false, allowEdge: false, allowPort: false },
    })
    graph.value = value
    value.on('scale', () => zoom.value = Math.round(value.zoom() * 100))
    value.on('node:change:position', ({ node }) => {
      if (applying)
        return
      manualPositions.set(node.id, node.position())
      for (const edge of value.getConnectedEdges(node))
        updateEdge(edge.id)
    })
    sync()
    if (viewport && viewport.width === element.clientWidth && viewport.height === element.clientHeight) {
      value.zoomTo(viewport.scale)
      value.translate(viewport.tx, viewport.ty)
    }
    else {
      place(true)
    }
    if (pendingFocus)
      focus(pendingFocus)
  }

  useIntersectionObserver(surface, ([entry]) => nearby.value = entry?.isIntersecting ?? false, { rootMargin: '240px' })
  useResizeObserver(surface, updateVisibility)
  watch(nearby, updateVisibility, { flush: 'post' })
  watch(geometry, () => {
    if (graph.value && !frame)
      frame = requestAnimationFrame(sync)
  }, { flush: 'post' })
  onBeforeUnmount(release)

  return {
    hosts: host.hosts,
    zoom,
    active: computed(() => graph.value !== null),
    fit: () => place(false),
    arrange: () => {
      manualPositions.clear()
      cancelAnimationFrame(frame)
      sync()
      place(false)
    },
    zoomBy: (amount: number) => graph.value?.zoom(amount),
    focus,
  }
}
