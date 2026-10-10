import type { Ref } from 'vue'
import type { ConversationCanvasDirection, ConversationCanvasNode } from '../../model/canvas/conversationCanvasLayout'
import type { ConversationCanvasData } from './conversationCanvasContext'
import { Graph, Snapline } from '@antv/x6'
import { useResizeObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { conversationCanvasConnection } from '../../model/canvas/conversationCanvasConnections'
import { createCanvasInteraction, resolveCanvasSimplifiedMode } from '../../model/canvas/conversationCanvasInteraction'
import { conversationNodeSize, layoutConversationCanvas } from '../../model/canvas/conversationCanvasLayout'
import { createConversationMinimap } from './conversationCanvasMinimap'
import { createConversationNodeHost } from './conversationCanvasNodeHost'

const VIEWPORT_MARGIN_PX = 240

export function useConversationCanvas(options: {
  container: Readonly<Ref<HTMLElement | null>>
  controls: Readonly<Ref<HTMLElement | null>>
  nodes: Readonly<Ref<readonly ConversationCanvasNode[]>>
  conversationId: Readonly<Ref<string | null>>
  direction: Readonly<Ref<ConversationCanvasDirection>>
  minimapContainer: Readonly<Ref<HTMLElement | null>>
  minimapVisible: Readonly<Ref<boolean>>
  active: Readonly<Ref<boolean>>
  canMutate: Readonly<Ref<boolean>>
}) {
  const graph = shallowRef<Graph | null>(null)
  const zoom = shallowRef(100)
  const simplified = shallowRef(false)
  const interacting = shallowRef(false)
  const nodeHost = createConversationNodeHost()
  const viewportByScope = new Map<string, { tx: number, ty: number, scale: number }>()
  const manualPositions = new Map<string, { x: number, y: number }>()
  const nodeData = new Map<string, ConversationCanvasData>()
  const messageSignatures = new WeakMap<ConversationCanvasNode, string>()
  const edgeStyles = new Map<string, string>()
  const geometry = computed(() => JSON.stringify(options.nodes.value.map((node) => {
    const { width, height } = conversationNodeSize(node)
    return [node.id, node.parentId, node.kind, width, height]
  })))
  let minimap: ReturnType<typeof createConversationMinimap> | null = null
  let layoutDirty = true
  let presentationDirty = true
  let frame = 0
  let scope = ''
  let applying = false
  let needsFit = true
  let preferReadableScale = false
  let focusAfterUpdate: string | null = null
  let zoomFrame = 0
  let placingViewport = false
  let inputSurface: HTMLElement | null = null
  const pointers = new Set<number>()
  const interaction = createCanvasInteraction({
    onStart: () => {
      interacting.value = true
      minimap?.setInteractionActive(true)
    },
    onEnd: () => {
      interacting.value = false
      schedule()
      minimap?.setInteractionActive(false)
    },
  })

  function updateRendering(reset = false) {
    if (graph.value)
      simplified.value = resolveCanvasSimplifiedMode(reset ? false : simplified.value, graph.value.zoom())
  }

  function placeViewport(update: () => void) {
    placingViewport = true
    try {
      update()
    }
    finally {
      placingViewport = false
    }
  }

  function interact(update: () => void) {
    if (!graph.value || !options.active.value)
      return
    interaction.touch()
    update()
  }

  function isCanvasInput(event: Event) {
    const target = event.target
    return target instanceof Node && (options.container.value?.contains(target) || options.minimapContainer.value?.contains(target))
  }

  function onWheel(event: WheelEvent) {
    if (options.active.value && isCanvasInput(event))
      interaction.touch()
  }

  function onPointerDown(event: PointerEvent) {
    if ((event.button !== 0 && event.button !== 1) || !options.active.value || !isCanvasInput(event))
      return
    pointers.add(event.pointerId)
    interaction.hold()
  }

  function onPointerEnd(event: PointerEvent) {
    if (!pointers.delete(event.pointerId) || pointers.size)
      return
    interaction.release()
  }

  function finishInteraction() {
    pointers.clear()
    interaction.finish()
  }

  function fit() {
    const value = graph.value
    if (!value || !options.container.value?.clientWidth || !value.getNodes().length)
      return
    syncSize(value)
    placeContent(value, value.getContentArea({ useCellGeometry: true }), 1)
    needsFit = false
  }

  function placeContent(value: Graph, bounds: { x: number, y: number, width: number, height: number }, maximumScale: number) {
    const container = options.container.value!.parentElement!.getBoundingClientRect()
    const controls = options.controls.value?.getBoundingClientRect()
    const right = controls ? controls.right - container.left + 24 : 32
    const below = controls ? controls.bottom - container.top + 24 : 32
    const areas = [
      { x: right, y: 32, width: container.width - right - 32, height: container.height - 64 },
      { x: 32, y: below, width: container.width - 64, height: container.height - below - 32 },
    ]
    const scaleFor = (area: typeof areas[number]) => Math.min(area.width / bounds.width, area.height / bounds.height)
    const area = areas.reduce((best, area) => scaleFor(area) > scaleFor(best) ? area : best)
    const scale = Math.max(0.2, Math.min(maximumScale, scaleFor(area)))
    const center = (start: number, extent: number, size: number, preferred: number) => size > extent
      ? start + extent / 2
      : Math.min(start + extent - size / 2, Math.max(start + size / 2, preferred))
    placeViewport(() => {
      value.zoomTo(scale)
      value.positionPoint(
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        center(area.x, area.width, bounds.width * scale, container.width / 2),
        center(area.y, area.height, bounds.height * scale, container.height / 2),
      )
    })
  }

  function syncSize(value: Graph) {
    const container = options.container.value?.parentElement
    if (container?.clientWidth && container.clientHeight
      && (value.options.width !== container.clientWidth || value.options.height !== container.clientHeight)) {
      value.resize(container.clientWidth, container.clientHeight)
    }
  }

  function focus(id: string) {
    focusAfterUpdate = id
    schedule()
  }

  function updateEdge(id: string) {
    const value = graph.value!
    const edge = value.getCellById(id)
    if (!edge?.isEdge())
      return
    const source = edge.getSourceNode()
    const target = edge.getTargetNode()
    if (!source || !target)
      return
    const connection = conversationCanvasConnection(
      source.getBBox(),
      target.getBBox(),
      options.direction.value,
    )
    edge.setSource({ cell: source.id, anchor: { name: 'topLeft', args: { dx: connection.sourceAnchor.x, dy: connection.sourceAnchor.y } }, connectionPoint: 'anchor' })
    edge.setTarget({ cell: target.id, anchor: { name: 'topLeft', args: { dx: connection.targetAnchor.x, dy: connection.targetAnchor.y } }, connectionPoint: 'anchor' })
    edge.setVertices(connection.vertices)
  }

  function syncLayout(value: Graph) {
    const positions = layoutConversationCanvas(options.nodes.value, options.direction.value)
    const ids = new Set(options.nodes.value.map(node => node.id))
    const desired = new Set(ids)
    for (const message of options.nodes.value) {
      const position = positions.get(message.id)!
      let node = value.getCellById(message.id)
      if (!node) {
        const data = createNodeData(message)
        node = value.addNode({ id: message.id, shape: 'buddy-conversation-message', ...position, data, zIndex: 1 })
        nodeData.set(message.id, data)
      }
      if (node.isNode()) {
        const location = manualPositions.get(message.id) ?? position
        if (node.position().x !== location.x || node.position().y !== location.y)
          node.position(location.x, location.y)
        if (node.size().width !== position.width || node.size().height !== position.height)
          node.resize(position.width, position.height)
      }
    }
    for (const message of options.nodes.value) {
      if (!message.parentId || !ids.has(message.parentId))
        continue
      const id = `edge:${message.parentId}:${message.id}`
      desired.add(id)
      const edge = value.getCellById(id) ?? value.addEdge({ id, source: message.parentId, target: message.id, connector: { name: 'rounded', args: { radius: 16 } }, zIndex: 0 })
      if (!edge.isEdge())
        continue
      updateEdge(id)
    }
    for (const cell of value.getCells()) {
      if (!desired.has(cell.id)) {
        value.removeCell(cell)
        nodeData.delete(cell.id)
        edgeStyles.delete(cell.id)
        manualPositions.delete(cell.id)
      }
    }
  }

  function createNodeData(message: ConversationCanvasNode): ConversationCanvasData {
    return {
      message,
      direction: options.direction.value,
      canMutate: options.canMutate.value,
    }
  }

  function messageSignature(message: ConversationCanvasNode) {
    let signature = messageSignatures.get(message)
    if (signature === undefined) {
      signature = JSON.stringify(message)
      messageSignatures.set(message, signature)
    }
    return signature
  }

  function sameData(previous: ConversationCanvasData | undefined, next: ConversationCanvasData) {
    return previous && previous.direction === next.direction && previous.canMutate === next.canMutate
      && (previous.message === next.message || messageSignature(previous.message) === messageSignature(next.message))
  }

  function syncPresentation(value: Graph) {
    const byId = new Map(options.nodes.value.map(node => [node.id, node]))
    for (const message of options.nodes.value) {
      const cell = value.getCellById(message.id)
      if (!cell)
        continue
      const data = createNodeData(message)
      if (!sameData(nodeData.get(message.id), data))
        cell.setData(data, { overwrite: true })
      nodeData.set(message.id, data)
      const parent = message.parentId ? byId.get(message.parentId) : null
      if (!parent)
        continue
      const id = `edge:${parent.id}:${message.id}`
      const edge = value.getCellById(id)
      if (!edge?.isEdge())
        continue
      const style = `${message.active}:${message.kind}`
      if (edgeStyles.get(id) !== style) {
        edge.attr('line', {
          stroke: message.active ? 'var(--buddy-accent-border)' : 'var(--buddy-border-strong)',
          strokeWidth: message.active ? 2 : 1.5,
          strokeDasharray: message.kind === 'draft' ? '5 5' : '',
          targetMarker: { name: 'block', width: 5, height: 4 },
        })
        edgeStyles.set(id, style)
      }
    }
  }

  function sync() {
    frame = 0
    const value = graph.value
    if (!value || !options.active.value)
      return
    const nextScope = `${options.conversationId.value}:${options.direction.value}`
    const switched = scope !== nextScope
    if (switched && interaction.active)
      return
    const changingConversation = !scope.startsWith(`${options.conversationId.value}:`)
    if (switched) {
      if (scope)
        viewportByScope.set(scope, { ...value.translate(), scale: value.zoom() })
      manualPositions.clear()
      focusAfterUpdate = null
      scope = nextScope
      layoutDirty = true
    }
    applying = true
    try {
      const updateLayout = layoutDirty && !interaction.active
      value.batchUpdate('conversation', () => {
        if (updateLayout)
          syncLayout(value)
        if (presentationDirty || updateLayout)
          syncPresentation(value)
      })
      if (updateLayout) {
        minimap?.refresh()
        layoutDirty = false
      }
      presentationDirty = false
    }
    finally {
      applying = false
    }
    if (interaction.active)
      return
    if (switched) {
      const saved = viewportByScope.get(scope)
      if (saved) {
        placeViewport(() => {
          value.zoomTo(saved.scale)
          value.translate(saved.tx, saved.ty)
        })
        needsFit = false
      }
      else {
        needsFit = true
        preferReadableScale = changingConversation
      }
    }
    if (needsFit) {
      fit()
      if (preferReadableScale && value.zoom() < 0.7) {
        placeViewport(() => value.zoomTo(0.8))
        const head = options.nodes.value.findLast(node => node.active)
        if (head)
          focus(head.id)
      }
    }
    preferReadableScale = false
    syncMinimap()
    if (focusAfterUpdate) {
      const focused = value.getCellById(focusAfterUpdate)
      if (focused) {
        syncSize(value)
        placeContent(value, focused.getBBox(), value.zoom())
        focusAfterUpdate = null
      }
    }
    updateRendering(switched)
  }

  function schedule() {
    if (!frame && options.active.value)
      frame = requestAnimationFrame(sync)
  }

  function scheduleLayout() {
    layoutDirty = true
    schedule()
  }

  function schedulePresentation() {
    presentationDirty = true
    schedule()
  }

  onMounted(() => {
    const value = new Graph({
      container: options.container.value!,
      autoResize: true,
      virtual: { enabled: true, margin: VIEWPORT_MARGIN_PX },
      createCellView: cell => cell.isNode() ? nodeHost.view : undefined,
      background: { color: 'transparent' },
      grid: { visible: true, size: 20, args: { color: '#a2a2a226', thickness: 1 } },
      panning: { enabled: true, eventTypes: ['leftMouseDown', 'mouseWheel', 'mouseWheelDown'] },
      mousewheel: { enabled: true, modifiers: 'ctrl', minScale: 0.2, maxScale: 1.8, zoomAtMousePosition: true },
      scaling: { min: 0.2, max: 1.8 },
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
    const onViewportChange = () => {
      if (!options.active.value)
        return
      if (!placingViewport && !applying)
        interaction.touch()
      if (!zoomFrame) {
        zoomFrame = requestAnimationFrame(() => {
          zoomFrame = 0
          zoom.value = Math.round(value.zoom() * 100)
          updateRendering()
        })
      }
    }
    value.on('scale', () => {
      value.options.virtual = { enabled: true, margin: VIEWPORT_MARGIN_PX / value.zoom() }
      value.enableVirtualRender()
      onViewportChange()
    })
    value.on('translate', onViewportChange)
    inputSurface = options.container.value!.parentElement
    inputSurface?.addEventListener('wheel', onWheel, { capture: true, passive: true })
    inputSurface?.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerEnd, true)
    window.addEventListener('pointercancel', onPointerEnd, true)
    window.addEventListener('blur', finishInteraction)
    value.use(new Snapline({ enabled: true, tolerance: 8 }))
    syncMinimap()
    value.on('node:change:position', ({ node }) => {
      if (applying)
        return
      manualPositions.set(node.id, node.position())
      for (const edge of value.getConnectedEdges(node)) updateEdge(edge.id)
      minimap?.refresh()
    })
    sync()
  })
  watch(geometry, scheduleLayout, { flush: 'post' })
  watch([options.conversationId, options.direction], () => {
    finishInteraction()
    scheduleLayout()
  }, { flush: 'sync' })
  watch(options.nodes, schedulePresentation, { flush: 'post' })
  watch(options.canMutate, schedulePresentation, { flush: 'sync' })
  function syncMinimap() {
    const value = graph.value
    if (!value)
      return
    if (options.active.value && options.minimapVisible.value && options.minimapContainer.value?.clientWidth && options.container.value?.clientWidth && !minimap) {
      minimap = createConversationMinimap(options.minimapContainer.value)
      minimap.setInteractionActive(interaction.active)
      value.use(minimap)
    }
    else if ((!options.active.value || !options.minimapVisible.value) && minimap) {
      value.disposePlugins(['minimap'])
      minimap = null
    }
  }
  watch([options.minimapVisible, options.active], () => {
    if (!options.active.value) {
      finishInteraction()
      cancelAnimationFrame(frame)
      frame = 0
      cancelAnimationFrame(zoomFrame)
      zoomFrame = 0
    }
    if (!options.active.value || !options.minimapVisible.value)
      syncMinimap()
    if (options.active.value)
      schedule()
  }, { flush: 'sync' })
  useResizeObserver(options.container, () => {
    if (needsFit || !minimap)
      schedule()
  })
  onBeforeUnmount(() => {
    inputSurface?.removeEventListener('wheel', onWheel, true)
    inputSurface?.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerEnd, true)
    window.removeEventListener('pointercancel', onPointerEnd, true)
    window.removeEventListener('blur', finishInteraction)
    interaction.dispose()
    interacting.value = false
    cancelAnimationFrame(frame)
    cancelAnimationFrame(zoomFrame)
    graph.value?.dispose()
    nodeHost.hosts.clear()
    graph.value = null
  })

  return {
    nodeHosts: nodeHost.hosts,
    zoom,
    simplified,
    interacting,
    fit: () => interact(fit),
    focus,
    resetZoom: () => interact(() => graph.value?.zoomTo(1)),
    zoomBy: (delta: number) => interact(() => graph.value?.zoom(delta)),
    resetLayout: () => {
      finishInteraction()
      manualPositions.clear()

      needsFit = true
      preferReadableScale = false

      scheduleLayout()
    },
  }
}
