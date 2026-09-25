import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type { WorkbenchLayout, WorkbenchNode, WorkbenchView } from '../common/workbench'
import { workbenchPresentationSchema } from '@buddy-shared/workbench/workbenchUi'
import { createLayout, panes, resourceKey } from '../common/workbench'

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function restoreWorkbenchLayout(value: unknown): WorkbenchLayout {
  const fallback = createLayout()
  if (!record(value) || (value.version !== 1 && value.version !== 2) || !record(value.views) || Object.keys(value.views).length > 512)
    return fallback
  const legacy = value.version === 1
  const views: Record<string, WorkbenchView> = Object.create(null)
  const legacyResources: JsonValue[] = []
  for (const [id, view] of Object.entries(value.views)) {
    if (!record(view) || view.id !== id || typeof view.type !== 'string' || typeof view.title !== 'string'
      || !record(view.resource) || typeof view.resource.scheme !== 'string' || typeof view.resource.id !== 'string'
      || !record(view.resource.data) || !record(view.state)) {
      continue
    }
    if (legacy && view.resource.scheme === 'task-resource') {
      if (record(view.resource.data.tab))
        legacyResources.push(view.resource.data.tab as JsonValue)
      continue
    }
    if (legacy && ['task-index', 'explorer', 'settings', 'automations', 'output'].includes(view.resource.scheme))
      continue
    let location = legacy ? ['task', 'draft'].includes(view.resource.scheme) ? 'main' : 'context' : view.location
    if (['workbench.top', 'workbench.bottom', 'workbench.floating'].includes(String(location)))
      location = 'mount'
    if (!['main', 'context', 'mount'].includes(String(location)))
      continue
    views[id] = { ...structuredClone(view), location } as unknown as WorkbenchView
    const presentation = workbenchPresentationSchema.safeParse(view.presentation)
    if (presentation.success)
      views[id]!.presentation = presentation.data
    else
      delete views[id]!.presentation
  }
  const seenNodes = new Set<string>()
  const seenResources = new Set<string>()
  const retained = new Set<string>()
  function restore(node: unknown, depth = 0): WorkbenchNode | null {
    if (!record(node) || depth > 32 || seenNodes.size >= 64 || typeof node.id !== 'string' || seenNodes.has(node.id))
      return null
    seenNodes.add(node.id)
    if (node.kind === 'pane') {
      const candidates = legacy && Array.isArray(node.views) ? [node.active, ...node.views] : [node.view]
      const id = candidates.find(id => typeof id === 'string' && views[id]?.location === 'main' && !seenResources.has(resourceKey(views[id]!.resource)))
      if (typeof id !== 'string')
        return null
      retained.add(id)
      seenResources.add(resourceKey(views[id]!.resource))
      return { kind: 'pane', id: node.id, view: id }
    }
    if (node.kind !== 'split')
      return null
    const first = restore(node.first, depth + 1)
    const second = restore(node.second, depth + 1)
    return first && second ? { kind: 'split', id: node.id, axis: node.axis === 'vertical' ? 'vertical' : 'horizontal', ratio: typeof node.ratio === 'number' && Number.isFinite(node.ratio) ? Math.max(0.15, Math.min(0.85, node.ratio)) : 0.5, first, second } : first ?? second
  }
  let root = restore(value.root)
  if (legacy && record(value.docks)) {
    for (const dock of Object.values(value.docks)) {
      const pane = record(dock) ? restore(dock.pane) : null
      if (pane)
        root = root ? { kind: 'split', id: crypto.randomUUID(), axis: 'horizontal', ratio: 0.5, first: root, second: pane } : pane
    }
  }
  root ??= fallback.root
  const activePane = typeof value.activePane === 'string' && panes(root).some(pane => pane.id === value.activePane) ? value.activePane : panes(root)[0]!.id
  const auxiliary = !legacy && record(value.auxiliary) ? structuredClone(value.auxiliary) as Record<string, JsonValue> : {}
  if (legacyResources.length)
    auxiliary.legacyResources = legacyResources
  return { version: 2, root, views: Object.fromEntries(Object.entries(views).filter(([id, view]) => retained.has(id) || view.location !== 'main')), activePane, auxiliary }
}
