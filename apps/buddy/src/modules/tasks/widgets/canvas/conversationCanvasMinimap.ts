import type { Dom, Graph } from '@antv/x6'
import { MiniMap, NodeView } from '@antv/x6'

class ConversationOverviewNodeView extends NodeView {
  protected renderMarkup() {
    return this.renderJSONMarkup({ tagName: 'rect', selector: 'body' })
  }

  update() {
    super.update({ body: {
      ...this.cell.size(),
      rx: 12,
      fill: 'var(--buddy-accent-border)',
      stroke: 'var(--buddy-text-muted)',
      strokeWidth: 1,
    } })
  }
}

class ConversationMiniMap extends MiniMap {
  private fitFrame = 0
  private pointerPosition: { x: number, y: number } | null = null
  private readonly capturePointer = (event: PointerEvent) => {
    this.pointerPosition = this.targetGraph.clientToLocal(event.clientX, event.clientY)
  }

  init(graph: Graph) {
    super.init(graph)
    this.container.addEventListener('pointerdown', this.capturePointer)
  }

  protected scrollTo(event: Dom.MouseDownEvent) {
    const point = this.pointerPosition
    this.pointerPosition = null
    if (point)
      this.sourceGraph.centerPoint(point.x, point.y)
    else
      super.scrollTo(event)
  }

  protected updatePaper(width: number, height: number): this
  protected updatePaper(size: { width: number, height: number }): this
  protected updatePaper(width: number | { width: number, height: number }, height?: number): this {
    const size = typeof width === 'number' ? { width, height: height! } : width
    if (size.width <= 0 || size.height <= 0)
      return this
    super.updatePaper(size)
    this.syncScale()
    return this
  }

  protected onModelUpdated() {
    this.refresh()
  }

  refresh() {
    if (!this.fitFrame) {
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = 0
        this.targetGraph.zoomToFit({ useCellGeometry: true })
        this.syncScale()
      })
    }
  }

  private syncScale() {
    this.ratio = this.targetGraph.transform.getScale().sx
    this.updateViewport()
  }

  dispose() {
    cancelAnimationFrame(this.fitFrame)
    this.container.removeEventListener('pointerdown', this.capturePointer)
    super.dispose()
  }
}

export function createConversationMinimap(container: HTMLElement) {
  return new ConversationMiniMap({
    container,
    width: container.clientWidth,
    height: container.clientHeight,
    padding: 12,
    scalable: false,
    graphOptions: {
      scaling: { min: 0.000001, max: 1 },
      createCellView: cell => cell.isNode() ? ConversationOverviewNodeView : null,
    },
  })
}
