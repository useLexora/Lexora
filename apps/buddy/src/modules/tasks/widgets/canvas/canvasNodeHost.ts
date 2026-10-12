import type { Node } from '@antv/x6'
import { Graph, NodeView } from '@antv/x6'
import { shallowReactive } from 'vue'

export const CANVAS_NODE_SHAPE = 'buddy-canvas-node'

Graph.registerNode(CANVAS_NODE_SHAPE, {
  markup: [{
    tagName: 'foreignObject',
    selector: 'fo',
    children: [{
      tagName: 'div',
      ns: 'http://www.w3.org/1999/xhtml',
      selector: 'foContent',
      style: { width: '100%', height: '100%' },
    }],
  }],
  attrs: { fo: { refWidth: '100%', refHeight: '100%', overflow: 'visible' } },
}, true)

export function createCanvasNodeHost() {
  const hosts = shallowReactive(new Map<string, { node: Node, container: HTMLElement }>())

  class CanvasNodeView extends NodeView {
    render() {
      super.render()
      hosts.set(this.cid, { node: this.cell, container: this.selectors.foContent as HTMLElement })
      return this
    }

    unmount() {
      hosts.delete(this.cid)
      return super.unmount()
    }
  }

  return { hosts, view: CanvasNodeView }
}
