import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { createBuddyNativeEnvironment } from '../../../platform/native/nativeHost'
import searchTools from '../../../platform/native/searchTools.json'
import { resolveBuddySearchToolsDirectory } from '../../../platform/process/serviceEnvironment'
import { resolveBuddyTarget } from '../../../platform/target'
import { establishWindowsRuntimeGuard } from '../../../platform/windows/runtimeGuard'
import { BUDDY_BUILTIN_SKILLS, BUDDY_FEATURES, resolveBuddyPlatform } from '../../../shared/platform'
import { runtimePreferencesSchema } from '../../../shared/runtime/runtimePreferences'
import { prepareRuntimeEnvironment } from './prepareRuntimeEnvironment'

const absolutePath = z.string().min(1).refine(isAbsolute)
export const nodeServiceConfigSchema = z.object({
  profile: z.enum(['stable', 'development', 'test']),
  buddyHome: absolutePath,
  resourcesRoot: absolutePath,
  proxy: z.object({ httpProxy: z.string(), httpsProxy: z.string(), noProxy: z.string() }).strict(),
  preferences: runtimePreferencesSchema,
  display: z.boolean(),
  storageAuthority: z.enum(['legacy_jsonl', 'sqlite']).optional(),
}).strict()
export type NodeServiceConfig = z.infer<typeof nodeServiceConfigSchema>

type LocalNodeConfig = Pick<NodeServiceConfig, 'profile' | 'buddyHome' | 'resourcesRoot'>

export async function inspectNodeServiceResources(config: LocalNodeConfig, signal?: AbortSignal) {
  const target = resolveBuddyTarget(process.platform, process.arch)
  const native = createBuddyNativeEnvironment({ serviceResourcesRoot: config.resourcesRoot })
  const searchDirectory = resolveBuddySearchToolsDirectory({ serviceResourcesRoot: config.resourcesRoot })
  const platform = resolveBuddyPlatform(process.platform)
  const skills = [...BUDDY_BUILTIN_SKILLS, ...platform.features.flatMap(id => BUDDY_FEATURES[id].skills)]
    .map(name => join(config.resourcesRoot, 'skills', name))
  for (const file of [...Object.values(native), ...Object.values(searchTools.tools).map(tool => join(searchDirectory, tool.targets[target.id].binary)), ...skills.map(directory => join(directory, 'SKILL.md'))]) {
    signal?.throwIfAborted()
    try {
      await access(file)
    }
    catch {
      throw new Error(`SERVICE_RESOURCE_MISSING: ${file}`)
    }
  }
  signal?.throwIfAborted()
  return {
    skills,
    environment: {
      ...native,
      LEXORA_BUDDY_HOME: config.buddyHome,
      LEXORA_BUDDY_PROFILE: config.profile,
      PI_CODING_AGENT_DIR: join(config.buddyHome, 'agent'),
      PI_TOOLS_DIR: searchDirectory,
    },
  }
}

export async function activateNodeService(resources: Awaited<ReturnType<typeof inspectNodeServiceResources>>): Promise<readonly string[]> {
  Object.assign(process.env, resources.environment)
  if (process.platform === 'win32')
    await establishWindowsRuntimeGuard()
  await prepareRuntimeEnvironment()
  return resources.skills
}

export async function prepareNodeService(config: NodeServiceConfig): Promise<readonly string[]> {
  return activateNodeService(await inspectNodeServiceResources(config))
}
