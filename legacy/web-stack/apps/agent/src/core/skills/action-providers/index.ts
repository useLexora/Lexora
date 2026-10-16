import type { RuntimeSkillActionProvider } from './types'
import { createLocationSkillActionProvider } from './builtin/location'
import { createMemorySkillActionProvider } from './builtin/memory'
import { createTimeSkillActionProvider } from './builtin/time'
import { createWebSearchSkillActionProvider } from './builtin/web-search/adapter'
import { createAmapMcpSkillActionProvider } from './mcp/amap'

export const DEFAULT_RUNTIME_SKILL_ACTION_PROVIDERS = [
  createTimeSkillActionProvider(),
  createLocationSkillActionProvider(),
  createMemorySkillActionProvider(),
  createWebSearchSkillActionProvider(),
  createAmapMcpSkillActionProvider(),
] as const

export function listRuntimeSkillActionProviderKeys(
  providers: readonly RuntimeSkillActionProvider[] = DEFAULT_RUNTIME_SKILL_ACTION_PROVIDERS,
): readonly string[] {
  return providers.map(provider => provider.key)
}

export type { RuntimeSkillActionProvider, RuntimeSkillActionProviderServices } from './types'
