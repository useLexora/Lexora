import type { BuddyCapability } from './BuddyCapability'
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent'

export const CODEMODE_EXTENSION = 'lexora-codemode'
export const CODEMODE_TOOL_NAME = 'codemode'

export class CodemodeCleanupIncompleteError extends Error {
  constructor() {
    super('CodeMode cleanup is incomplete; the session cannot continue safely')
    this.name = 'CodemodeCleanupIncompleteError'
  }
}

type CodemodeRuntimeOptions = NonNullable<Parameters<typeof createCodemodeExtension>[0]>['runtime']

export function createCodemodeCapability(
  isEnabled: () => boolean,
  runtime?: CodemodeRuntimeOptions,
): BuddyCapability & { assertReady: () => void } {
  let poisoned = false
  let pending = 0
  const assertReady = () => {
    if (poisoned)
      throw new CodemodeCleanupIncompleteError()
  }
  const extension = createCodemodeExtension({
    mode: 'only',
    models: false,
    runtime: {
      computeTimeoutMs: 30_000,
      maxPendingToolCalls: 16,
      maxQueuedToolCalls: 128,
      ...runtime,
      onCleanupIncomplete(cleanup) {
        poisoned = true
        pending++
        void cleanup.then(() => {
          pending--
        })
        runtime?.onCleanupIncomplete?.(cleanup)
      },
    },
  })
  return {
    assertReady,
    dispose() {
      if (pending > 0)
        throw new CodemodeCleanupIncompleteError()
    },
    extension: {
      name: CODEMODE_EXTENSION,
      factory(pi) {
        pi.on('tool_call', () => poisoned ? { block: true, reason: new CodemodeCleanupIncompleteError().message } : undefined)
        return extension(pi)
      },
    },
    classify: event => event.toolName === CODEMODE_TOOL_NAME ? { access: 'read', paths: [] } : null,
    disclosure: [{
      source: { kind: 'builtin', id: 'codemode', title: 'Tool orchestration' },
      exposure: 'direct',
      keywords: 'JavaScript parallel batch filter tools',
      tools: [{ name: CODEMODE_TOOL_NAME }],
      available: isEnabled,
    }],
  }
}
