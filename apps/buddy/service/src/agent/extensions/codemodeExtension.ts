import type { BuddyCapability } from './BuddyCapability'
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent'

export const CODEMODE_EXTENSION = 'lexora-codemode'
export const CODEMODE_TOOL_NAME = 'codemode'

export function createCodemodeCapability(isEnabled: () => boolean): BuddyCapability {
  return {
    extension: {
      name: CODEMODE_EXTENSION,
      factory: createCodemodeExtension({
        mode: 'on',
        models: false,
        runtime: { computeTimeoutMs: 30_000, maxPendingToolCalls: 16, maxQueuedToolCalls: 128 },
      }),
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
