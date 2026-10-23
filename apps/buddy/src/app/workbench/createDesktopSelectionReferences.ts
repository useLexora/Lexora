import type { Ref } from 'vue'
import type { BuiltinSelectionReferenceOptions } from './builtinSelectionReferenceProviders'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { SelectionReferenceTarget } from '@/shared/ui/selection/workbenchSelectionReferences'
import { buddyUserContentToText } from '@buddy-shared/conversation/buddyUserContent'
import { getCurrentScope, onScopeDispose } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { chatComposerDocumentToUserContent, userContentToChatComposerDocument } from '@/modules/prompt-input'
import { WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { panes } from '@/workbench/common/workbench'
import { registerBuiltinSelectionReferenceProviders } from './builtinSelectionReferenceProviders'

export function createDesktopSelectionReferences(options: BuiltinSelectionReferenceOptions & {
  pool: TaskWorkspacePool
  language: Readonly<Ref<BuddyLocale>>
}) {
  const references = new WorkbenchSelectionReferences({
    available: options.ready,
    isSplit: () => panes(options.controller.layout.root).length > 1,
    captureLocateScope() {
      const version = options.navigationVersion()
      const resources = options.resources()
      const scope = resources.selectionScope.value
      const independent = options.independent()
      return () => options.navigationVersion() === version && options.resources() === resources
        && resources.selectionScope.value === scope && options.independent() === independent
    },
    targets() {
      if (!options.ready())
        return []
      return panes(options.controller.layout.root).flatMap((pane, index): SelectionReferenceTarget[] => {
        const view = pane.view ? options.controller.layout.views[pane.view] : null
        const task = view && options.pool.peek(view.resource)
        if (!view || !task || task.workspace.restoration.state.value !== 'ready' || task.workspace.status.isClosing.value
          || task.workspace.execution.isSending.value || task.workspace.execution.isMutatingBranch.value) {
          return []
        }
        const workspace = task.workspace
        const title = workspace.session.currentTitle.value || view.title
        return [{
          id: view.id,
          identity: JSON.stringify([workspace.composer.draftId.value, workspace.composer.editorKey.value, workspace.composer.target.value, task.session.navigationVersion()]),
          scope: workspace.session.activeConversationId.value ? `task:${workspace.session.activeConversationId.value}` : `draft:${workspace.composer.draftId.value}`,
          label: translateBuddy(options.language.value, 'desktop.chat.quoteTargetPane', { index: index + 1, title }),
          read: () => chatComposerDocumentToUserContent(workspace.composer.composerContent.value),
          write: content => workspace.composer.updateComposerContent(buddyUserContentToText(content), userContentToChatComposerDocument(content)),
        }]
      })
    },
  })
  registerBuiltinSelectionReferenceProviders(references, options)
  if (getCurrentScope())
    onScopeDispose(() => references.dispose())
  return references
}
