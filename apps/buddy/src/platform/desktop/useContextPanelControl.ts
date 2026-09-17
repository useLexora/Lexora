import type { ContextPanelApi, ContextPanelCommand, ContextPanelSource, ContextPanelState } from '@buddy-shared/context-panel/contextPanel'
import { contextPanelStateSchema } from '@buddy-shared/context-panel/contextPanel'
import { computed, onScopeDispose, shallowRef } from 'vue'

export function useContextPanelControl(options: {
  api: ContextPanelApi
  getSource: () => ContextPanelSource | null
  onTarget: (target: NonNullable<ContextPanelState['target']>) => void
  onError: () => void
}) {
  const state = shallowRef<ContextPanelState>({ revision: -1, open: false, target: null })
  let disposed = false
  function apply(value: ContextPanelState) {
    const next = contextPanelStateSchema.parse(value)
    if (disposed || next.revision <= state.value.revision)
      return
    state.value = next
    if (next.open && next.target)
      options.onTarget(next.target)
  }
  const stop = options.api.onStateChanged(apply)
  void options.api.getState().then(apply).catch(options.onError)
  onScopeDispose(() => {
    disposed = true
    stop()
  })

  async function execute(command: ContextPanelCommand) {
    try {
      apply(await options.api.execute(command))
    }
    catch {
      if (!disposed)
        options.onError()
    }
  }

  return {
    isOpen: computed(() => state.value.open),
    open: () => execute({ action: 'open', source: options.getSource() }),
    close: () => execute({ action: 'close', source: options.getSource() }),
    toggle: () => execute({ action: state.value.open ? 'close' : 'open', source: options.getSource() }),
  }
}
