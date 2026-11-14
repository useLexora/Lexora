import type { StorageProtection } from '../storage/ProfileLocations'
import { userInfo } from 'node:os'
import process from 'node:process'
import { resolveBuddyPlatform } from '../../shared/platform'
import { isWindows } from '../../shared/platform/identifiers'
import { filePathAdapters } from '../filesystem/filePaths'
import searchTools from '../native/searchTools.json'
import { createChildProcessEnvironment } from '../process/childProcessEnvironment'
import { createProxyEnvironment } from '../process/proxyEnvironment'
import { createToolchainEnvironment } from '../process/toolchainEnvironment'
import { resolveBuddyTarget } from '../target'

export function resolveBuddySearchToolsDirectory(options: {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  platform?: NodeJS.Platform
  architecture?: string
}): string {
  const platform = resolveBuddyPlatform(options.platform ?? process.platform)
  const { id: target } = resolveBuddyTarget(platform.id, options.architecture ?? process.arch)
  if (!Object.values(searchTools.tools).every(tool => Object.hasOwn(tool.targets, target)))
    throw new Error(`Unsupported search tools target: ${target}`)
  return filePathAdapters[platform.id].resolveInput(
    options.isPackaged ? searchTools.resource.to : `${searchTools.resource.from}/${target}`,
    options.isPackaged ? options.resourcesPath : options.appPath,
  )
}

export function createBuddyServiceEnvironment(
  source: NodeJS.ProcessEnv,
  buddyHome: string,
  platform: NodeJS.Platform = process.platform,
  proxyUrl?: string,
  storageProtection?: StorageProtection,
): NodeJS.ProcessEnv {
  const targetPlatform = resolveBuddyPlatform(platform)
  const environmentSource = !isWindows(targetPlatform.id) && !source.HOME
    ? { ...source, HOME: userInfo().homedir }
    : source
  const recoveryMode = Object.entries(environmentSource).find(([name]) => (
    (targetPlatform.environment.caseSensitive ? name : name.toUpperCase()) === 'LEXORA_BUDDY_EVENT_RECOVERY'
  ))?.[1]
  const environment = createChildProcessEnvironment({
    source: environmentSource,
    platform: targetPlatform,
    additions: {
      ...createToolchainEnvironment(environmentSource, targetPlatform.id),
      LEXORA_BUDDY_HOME: buddyHome,
      LEXORA_BUDDY_STORAGE_PROTECTION: storageProtection ? JSON.stringify(storageProtection.sensitiveRoots) : undefined,
      LEXORA_BUDDY_EVENT_RECOVERY: recoveryMode === 'full' ? 'full' : undefined,
      LEXORA_BUDDY_STORAGE_AUTHORITY: environmentSource.LEXORA_BUDDY_STORAGE_AUTHORITY === 'sqlite' ? 'sqlite' : undefined,
      NODE_USE_ENV_PROXY: '1',
      PI_CODING_AGENT_DIR: filePathAdapters[targetPlatform.id].resolveInput('agent', buddyHome),
    },
  })
  if (proxyUrl) {
    for (const key of Object.keys(environment)) {
      if (/^(?:https?|all|no)_proxy$/i.test(key))
        delete environment[key]
    }
    Object.assign(environment, createProxyEnvironment(proxyUrl))
  }
  return environment
}
