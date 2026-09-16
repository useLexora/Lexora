import { homedir } from 'node:os'
import process from 'node:process'
import { filePathAdapters } from '../../../platform/filesystem/filePaths'
import searchTools from '../../../platform/native/searchTools.json'
import { createChildProcessEnvironment } from '../../../platform/process/childProcessEnvironment'
import { createProxyEnvironment } from '../../../platform/process/proxyEnvironment'
import { resolveBuddyPlatform } from '../../../shared/platform'

export function resolveBuddySearchToolsDirectory(options: {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  platform?: NodeJS.Platform
  architecture?: string
}): string {
  const platform = resolveBuddyPlatform(options.platform ?? process.platform)
  const target = `${platform.id}-${options.architecture ?? process.arch}`
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
): NodeJS.ProcessEnv {
  const targetPlatform = resolveBuddyPlatform(platform)
  const environmentSource = targetPlatform.id === 'linux' && !source.HOME
    ? { ...source, HOME: homedir() }
    : source
  const environment = createChildProcessEnvironment({
    source: environmentSource,
    platform: targetPlatform,
    additions: {
      LEXORA_BUDDY_HOME: buddyHome,
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
