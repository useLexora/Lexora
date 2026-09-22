import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { buddyColorThemes, createBuddyColorVariables } from '@/theme/buddyTheme'
import { panes } from '@/workbench/common/workbench'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'
import DesktopFileContribution from './DesktopFileContribution.vue'
import DesktopTaskContribution from './DesktopTaskContribution.vue'

export function registerDesktopContributions(controller: WorkbenchController, copies: WorkingCopyService, language: () => string) {
  const labels = () => workbenchLabels(language())
  controller.registry.register('lexora.tasks', (scope) => {
    scope.view({ id: 'tasks.editor', factory: DesktopTaskContribution, label: 'Task', supports: resource => ['task', 'draft'].includes(resource.scheme), multiple: false })
  })
  controller.registry.register('lexora.files', (scope) => {
    scope.view({ id: 'files.preview', factory: DesktopFileContribution, label: 'Preview', location: 'context', supports: resource => resource.scheme === 'file-preview', multiple: true })
    scope.view({ id: 'files.editor', factory: DesktopFileContribution, label: 'Text editor', location: 'context', supports: resource => resource.scheme === 'file', multiple: true, priority: 10 })
    scope.command({ id: 'file.save', get label() {
      return labels().save
    }, keybinding: 'Mod+S', shortcutScope: 'context', enabled: context => !!context.view && copies.dirty(context.view.resource), execute: context => copies.save(context.view!.resource) })
  })
  controller.registry.register('lexora.workbench', (scope) => {
    for (const theme of Object.values(buddyColorThemes))
      scope.theme({ id: theme.colorScheme, colorScheme: theme.colorScheme, tokens: createBuddyColorVariables(theme) })
    scope.command({ id: 'editor.wordWrap', label: language() === 'en-US' ? 'Toggle word wrap' : '切换自动换行', enabled: context => context.values['resource.scheme'] === 'file', execute: (context) => {
      const view = context.view!
      controller.updateView(view.id, { state: { ...view.state, wrap: !(view.state.wrap ?? controller.configuration.get('workbench.wordWrap')) } })
    } })
    scope.configuration({ id: 'workbench.tabSize', defaultValue: 2, validate: value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8 })
    scope.configuration({ id: 'workbench.wordWrap', defaultValue: false, validate: value => typeof value === 'boolean' })
    scope.command({ id: 'view.close', get label() {
      return labels().closeTask
    }, keybinding: 'Mod+W', shortcutScope: 'main', enabled: context => context.view?.location === 'main' && Number(context.values['pane.count'] ?? 1) > 1, execute: context => controller.close(context.view!.id) })
    scope.command({ id: 'view.focusNext', get label() {
      return labels().focusNext
    }, keybinding: 'Mod+J', execute: () => {
      const groups = panes(controller.layout.root)
      const pane = groups[(groups.findIndex(pane => pane.id === controller.layout.activePane) + 1) % groups.length]
      if (pane) {
        controller.activate(pane.id)
        document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`)?.focus()
      }
    } })
    scope.command({ id: 'view.moveNext', get label() {
      return labels().moveNext
    }, keybinding: 'Mod+Shift+J', shortcutScope: 'main', enabled: context => context.view?.location === 'main', execute: (context) => {
      const groups = panes(controller.layout.root)
      const index = groups.findIndex(pane => pane.id === context.pane?.id)
      const target = groups[(index + 1) % groups.length]
      if (target)
        return controller.move(context.view!.id, target.id)
    } })
  })
}
