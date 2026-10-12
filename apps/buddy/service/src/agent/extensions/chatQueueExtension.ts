import type { BuddyExtensionRunContext } from './BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'

export function createChatQueueExtension(options: {
  getRunContext: () => BuddyExtensionRunContext | null
  followUp: (runId: string, signal: AbortSignal) => Promise<void>
}): BuddyInProcessExtension {
  return {
    name: 'lexora-chat-queue',
    factory(pi) {
      pi.on('agent_end', async (event) => {
        const run = options.getRunContext()
        const last = event.messages.at(-1)
        if (!run || run.deferQueuedInputs || run.signal.aborted || last?.role !== 'assistant' || last.stopReason !== 'stop')
          return
        await run.flushProjectedEvents()
        if (options.getRunContext() !== run || run.signal.aborted)
          return
        await options.followUp(run.runId, run.signal)
      })
    },
  }
}
