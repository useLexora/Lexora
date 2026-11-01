import type { StorageProtection } from '../../../platform/storage/ProfileLocations'
import { userInfo } from 'node:os'
import process from 'node:process'
import { filePathAdapters } from '../../../platform/filesystem/filePaths'
import searchTools from '../../../platform/native/searchTools.json'
import { createChildProcessEnvironment } from '../../../platform/process/childProcessEnvironment'
import { createProxyEnvironment } from '../../../platform/process/proxyEnvironment'
import { createToolchainEnvironment } from '../../../platform/process/toolchainEnvironment'
import { resolveBuddyTarget } from '../../../platform/target'
import { resolveBuddyPlatform } from '../../../shared/platform'
import { isWindows } from '../../../shared/platform/identifiers'

// Pi's CLI runs one session per process, so two codemode workers are enough there.
// This service runs every session and in-process subagent in one process, and a
// script that calls subagents holds its worker until they return. pi-web uses the
// same host shape and defaults the shared limit to 8. A value the user set is
// passed through unchanged, including values Pi rejects.
const DEFAULT_PI_CODEMODE_MAX_WORKERS = '8'
const PI_CODEMODE_MAX_WORKERS = 'PI_CODEMODE_MAX_WORKERS'

function codemodeWorkerLimit(source: NodeJS.ProcessEnv, caseSensitive: boolean): string {
  const value = Object.entries(source).find(([name]) => (
    (caseSensitive ? name : name.toUpperCase()) === PI_CODEMODE_MAX_WORKERS
  ))?.[1]
  return value === undefined || value === '' ? DEFAULT_PI_CODEMODE_MAX_WORKERS : value
}

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
      NODE_USE_ENV_PROXY: '1',
      PI_CODING_AGENT_DIR: filePathAdapters[targetPlatform.id].resolveInput('agent', buddyHome),
      PI_CODEMODE_MAX_WORKERS: codemodeWorkerLimit(environmentSource, targetPlatform.environment.caseSensitive),
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
