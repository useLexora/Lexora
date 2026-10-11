import type { BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'

export function createModelSwitchExtension(runContext: BuddyExtensionRunContextStore): BuddyInProcessExtension {
  return {
    name: 'lexora-model-switch',
    factory(pi) {
      pi.on('agent_before_settle', (event) => {
        const run = runContext.current
        if (!run?.retryModelChanged || run.signal.aborted)
          return
        run.retryModelChanged = false
        if (event.context.canContinue)
          return { continue: true }
      })
    },
  }
}
