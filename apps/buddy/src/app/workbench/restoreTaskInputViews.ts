import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { WorkbenchLayout } from '@/workbench/common/workbench'
import { createPane, panes, removePane } from '@/workbench/common/workbench'
import { isLegacyDraftResource, parseTaskResource, taskResource } from './taskResource'

export async function restoreTaskInputViews(layout: WorkbenchLayout, api: Pick<LocalChatApi['composerDrafts'], 'find'>): Promise<void> {
  for (const view of Object.values(layout.views)) {
    const resource = parseTaskResource(view.resource)
    if (!resource || resource.scheme !== 'draft' || isLegacyDraftResource(resource))
      continue
    const draft = await api.find(view.resource.id)
    if (draft?.scope.kind === 'task')
      continue
    if (draft && 'conversationId' in draft.scope) {
      view.resource = taskResource(draft.scope.conversationId, 'branchId' in draft.scope ? draft.scope.branchId : undefined)
      continue
    }
    if (draft)
      continue
    delete layout.views[view.id]
    const pane = panes(layout.root).find(pane => pane.view === view.id)
    if (pane)
      layout.root = removePane(layout.root, pane.id) ?? createPane(pane.id)
  }
  if (!panes(layout.root).some(pane => pane.id === layout.activePane))
    layout.activePane = panes(layout.root)[0]!.id
}
