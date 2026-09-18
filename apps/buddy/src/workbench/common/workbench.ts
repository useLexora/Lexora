import type { ShortcutScope } from '@buddy-shared/shortcuts/keybinding'
import type { JsonValue } from '@buddy-shared/workbench/workbenchState'

export interface ResourceRef { scheme: string, id: string, data: Record<string, JsonValue> }
export type ViewLocation = 'main' | 'context'
export type SplitDirection = 'left' | 'right' | 'up' | 'down'
export type DropPosition = SplitDirection | 'center'
export interface WorkbenchView {
  id: string
  type: string
  location: ViewLocation
  resource: ResourceRef
  title: string
  state: Record<string, JsonValue>
}
export interface WorkbenchPane { kind: 'pane', id: string, view: string | null }
export interface WorkbenchSplit {
  kind: 'split'
  id: string
  axis: 'horizontal' | 'vertical'
  ratio: number
  first: WorkbenchNode
  second: WorkbenchNode
}
export type WorkbenchNode = WorkbenchPane | WorkbenchSplit
export interface WorkbenchLayout {
  version: 2
  root: WorkbenchNode
  views: Record<string, WorkbenchView>
  activePane: string
  auxiliary: Record<string, JsonValue>
}
export interface ViewDescriptor {
  factory?: unknown
  id: string
  owner: string
  label: string
  location?: ViewLocation
  supports: (resource: ResourceRef) => boolean
  priority?: number
  multiple: boolean
}
export interface CommandContext {
  view: WorkbenchView | null
  pane: WorkbenchPane | null
  values: Readonly<Record<string, boolean | string | number>>
}
export interface WorkbenchCommand {
  id: string
  label: string
  keybinding?: string
  alternateKeybindings?: readonly string[]
  shortcutScope?: ShortcutScope
  enabled?: (context: CommandContext) => boolean
  execute: (context: CommandContext) => void | Promise<unknown>
}
export function resourceKey(resource: ResourceRef): string {
  return JSON.stringify([resource.scheme, resource.id])
}
export function createPane(id: string = crypto.randomUUID()): WorkbenchPane {
  return { kind: 'pane', id, view: null }
}
export function createLayout(): WorkbenchLayout {
  const root = createPane()
  return { version: 2, root, views: {}, activePane: root.id, auxiliary: {} }
}
export function panes(node: WorkbenchNode): WorkbenchPane[] {
  return node.kind === 'pane' ? [node] : [...panes(node.first), ...panes(node.second)]
}
export function mapNode(node: WorkbenchNode, id: string, replace: (node: WorkbenchNode) => WorkbenchNode): WorkbenchNode {
  if (node.id === id)
    return replace(node)
  return node.kind === 'pane' ? node : { ...node, first: mapNode(node.first, id, replace), second: mapNode(node.second, id, replace) }
}
export function removePane(node: WorkbenchNode, id: string): WorkbenchNode | null {
  if (node.id === id)
    return null
  if (node.kind === 'pane')
    return node
  const first = removePane(node.first, id)
  const second = removePane(node.second, id)
  return first && second ? { ...node, first, second } : first ?? second
}
