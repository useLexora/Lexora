import type { SessionEntry } from '@earendil-works/pi-coding-agent'

export const TOOL_DISCOVERY_STATE = 'lexora.tool-discovery'

export interface ToolDiscoveryState {
  version: 1
  discovered: readonly string[]
}

export function readToolDiscoveryState(branch: readonly SessionEntry[]): ToolDiscoveryState | undefined {
  for (const entry of branch.toReversed()) {
    if (entry.type !== 'custom' || entry.customType !== TOOL_DISCOVERY_STATE)
      continue
    const state = entry.data as Partial<ToolDiscoveryState> | undefined
    if (state?.version === 1 && Array.isArray(state.discovered) && state.discovered.every(id => typeof id === 'string'))
      return { version: 1, discovered: [...new Set(state.discovered)] }
  }
}
