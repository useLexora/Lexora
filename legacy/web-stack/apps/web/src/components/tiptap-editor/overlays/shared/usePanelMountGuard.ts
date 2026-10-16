import type { Ref, WatchSource } from 'vue'
import { watch } from 'vue'

interface DismissablePanelController {
  isOpen: Ref<boolean>
  dismiss: () => void
}

export function usePanelMountGuard(
  panel: DismissablePanelController,
  shouldKeepMounted: WatchSource<boolean>,
) {
  watch(shouldKeepMounted, (nextShouldKeepMounted) => {
    if (!panel.isOpen.value || nextShouldKeepMounted) {
      return
    }

    panel.dismiss()
  })
}
