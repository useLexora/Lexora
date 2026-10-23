import type { WorkbenchLauncherIcon } from '../common/workbench'
import type { WorkbenchController } from '../services/WorkbenchController'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { commandLabel } from '../common/workbench'

export interface WorkbenchLauncherAction {
  readonly id: string
  readonly label: string
  readonly icon?: WorkbenchLauncherIcon
  readonly disabled: boolean
}

export function useWorkbenchLaunchers(controller: WorkbenchController) {
  const { registry, contextKeys, commands } = controller
  const revision = shallowRef(0)
  const pending = shallowRef<ReadonlySet<string>>(new Set())
  let disposed = false
  onScopeDispose(controller.subscribe(() => revision.value++))
  onScopeDispose(() => {
    disposed = true
  })
  const actions = computed<readonly WorkbenchLauncherAction[]>(() => {
    void revision.value
    const values = contextKeys.snapshot()
    return [...registry.launchers.values()]
      .filter(launcher => !launcher.when || launcher.when(values))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
      .map(launcher => ({ id: launcher.id, label: commandLabel(launcher), icon: launcher.icon, disabled: pending.value.has(launcher.command) || !commands.isEnabled(launcher.command, { source: 'menu' }) }))
  })
  async function launch(id: string): Promise<boolean> {
    const launcher = registry.launchers.get(id)
    const values = contextKeys.snapshot()
    if (disposed || !launcher || pending.value.has(launcher.command) || (launcher.when && !launcher.when(values)))
      return false
    pending.value = new Set([...pending.value, launcher.command])
    try {
      return (await commands.execute(launcher.command, { source: 'menu' })).status === 'completed'
    }
    finally {
      pending.value = new Set([...pending.value].filter(value => value !== launcher.command))
    }
  }
  return { actions, launch }
}
