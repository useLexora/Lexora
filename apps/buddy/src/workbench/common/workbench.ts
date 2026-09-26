import type { ShortcutScope } from '@buddy-shared/shortcuts/keybinding'
import type { WorkbenchCondition } from '@buddy-shared/workbench/workbenchContext'
import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type { WorkbenchMountTarget, WorkbenchPresentation } from '@buddy-shared/workbench/workbenchUi'

export interface ResourceRef { scheme: string, id: string, data: Record<string, JsonValue> }
export type ViewLocation = 'main' | 'context' | 'mount'
export type SplitDirection = 'left' | 'right' | 'up' | 'down'
export type DropPosition = SplitDirection | 'center'
export interface WorkbenchView {
  id: string
  type: string
  location: ViewLocation
  placement?: string
  interactionId?: string
  mountInstanceId?: string
  presentation?: WorkbenchPresentation
  resource: ResourceRef
  title: string
  state: Record<string, JsonValue>
}
export interface WorkbenchPane { readonly kind: 'pane', readonly id: string, readonly view: string | null }
export interface WorkbenchSplit {
  readonly kind: 'split'
  readonly id: string
  readonly axis: 'horizontal' | 'vertical'
  readonly ratio: number
  readonly first: WorkbenchNode
  readonly second: WorkbenchNode
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
  when?: WorkbenchCondition
  renderer: string
  id: string
  owner: string
  label: string
  locations: readonly [ViewLocation, ...ViewLocation[]]
  supports: (resource: ResourceRef) => boolean
  priority?: number
  prepareBeforeOpen?: boolean
  multiple: boolean
}
export interface ViewPlacement {
  when?: WorkbenchCondition
  id: string
  viewType: string
  location: 'mount'
  target: WorkbenchMountTarget
  interaction?: 'regions' | 'exclusive'
  presentation: WorkbenchPresentation
}
export interface CommandContext {
  source?: 'palette' | 'slash'
  arguments?: string
  view: WorkbenchView | null
  pane: WorkbenchPane | null
  values: Readonly<Record<string, boolean | string | number>>
}
export interface WorkbenchCommand {
  id: string
  label: string
  slash?: { name: string, description?: string, origin?: import('@buddy-shared/workbench/workbenchCommand').WorkbenchCommandOrigin }
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
  if (node.kind === 'pane')
    return node
  const first = mapNode(node.first, id, replace)
  const second = mapNode(node.second, id, replace)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
export function removePane(node: WorkbenchNode, id: string): WorkbenchNode | null {
  if (node.id === id)
    return null
  if (node.kind === 'pane')
    return node
  const first = removePane(node.first, id)
  const second = removePane(node.second, id)
  if (!first || !second)
    return first ?? second
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
