import type { Node } from '@antv/x6'
import { Graph, Markup, NodeView } from '@antv/x6'
import { shallowReactive } from 'vue'

Graph.registerNode('buddy-conversation-message', {
  markup: [Markup.getForeignObjectMarkup()],
  attrs: { fo: { refWidth: '100%', refHeight: '100%', overflow: 'visible' } },
}, true)

export function createConversationNodeHost() {
  const hosts = shallowReactive(new Map<string, { node: Node, container: HTMLElement }>())

  class ConversationNodeView extends NodeView {
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

  return { hosts, view: ConversationNodeView }
}
