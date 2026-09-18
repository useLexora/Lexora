import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { createPane, panes, removePane } from '@/workbench/common/workbench'

export async function restoreTaskInputViews(layout: WorkbenchController['layout'], api: Pick<LocalChatApi['composerDrafts'], 'find'>): Promise<void> {
  for (const view of Object.values(layout.views)) {
    if (view.resource.scheme !== 'draft' || view.resource.id === 'global' || view.resource.id === view.resource.data.spaceId)
      continue
    const draft = await api.find(view.resource.id)
    if (draft?.scope.kind === 'task')
      continue
    if (draft && 'conversationId' in draft.scope) {
      view.resource = { scheme: 'task', id: draft.scope.conversationId, data: {} }
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
