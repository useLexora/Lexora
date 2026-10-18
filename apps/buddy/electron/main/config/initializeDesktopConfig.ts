import type { LexoraConfig } from '../../shared/desktopApi'
import type { LexoraConfigStore } from './LexoraConfigStore'
import { lstat, readdir } from 'node:fs/promises'

export function resolveSystemLanguage(languages: readonly string[]): LexoraConfig['desktop']['language'] {
  for (const language of languages) {
    const base = language.trim().toLowerCase().split(/[-_]/)[0]
    if (base === 'zh')
      return 'zh-CN'
    if (base === 'en')
      return 'en-US'
  }
  return 'en-US'
}

export async function initializeDesktopConfig(store: LexoraConfigStore, options: {
  configPath: string
  buddyHome: string
  languages: readonly string[]
}): Promise<LexoraConfig> {
  const [config, data] = await Promise.all([
    lstat(options.configPath).catch(missing),
    readdir(options.buddyHome).catch(missing),
  ])
  if (config || data?.length)
    return store.read()
  return store.update({ desktop: { onboardingCompleted: false, language: resolveSystemLanguage(options.languages) } })
}

function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT')
    throw error
  return undefined
}
