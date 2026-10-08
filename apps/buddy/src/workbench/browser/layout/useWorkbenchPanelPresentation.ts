import type { WorkbenchController } from '../../services/WorkbenchController'
import { computed, onScopeDispose, shallowRef } from 'vue'

export function useWorkbenchPanelPresentation(controller: WorkbenchController, mainActive: () => boolean) {
  const preferredContextOnLeft = shallowRef(false)
  const maximized = shallowRef(false)
  const dragging = shallowRef(false)
  const contextOnLeft = computed(() => mainActive() && preferredContextOnLeft.value)
  const contextMaximized = computed(() => maximized.value && !dragging.value)
  const mainVisible = computed(() => mainActive() && !contextMaximized.value)

  function restore() {
    maximized.value = false
  }

  onScopeDispose(controller.onDidChangeFocus(({ context }) => {
    if (context.values['focus.area'] === 'main')
      restore()
  }).dispose)
  onScopeDispose(controller.navigation.onDidChange(({ kind }) => {
    if (kind === 'started')
      restore()
  }).dispose)

  return {
    contextOnLeft,
    contextMaximized,
    mainVisible,
    restore,
    swap() {
      if (mainActive() && !contextMaximized.value)
        preferredContextOnLeft.value = !preferredContextOnLeft.value
    },
    toggleMaximize() {
      maximized.value = !maximized.value
    },
    beginDrag() {
      dragging.value = true
    },
    endDrag(dropped: boolean) {
      if (dropped)
        restore()
      dragging.value = false
    },
  }
}

export type WorkbenchPanelPresentation = ReturnType<typeof useWorkbenchPanelPresentation>
