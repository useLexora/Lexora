import type { BuddyPlatformId } from '../../shared/platform'
import { currentPlatform } from '../currentPlatform'
import { filePaths } from './filePaths'

interface SensitiveLocations {
  absolute: readonly string[]
  environment: readonly {
    key: string
    homeFallback?: string
    paths: readonly string[]
  }[]
}

const WINDOWS_CREDENTIAL_DIRECTORIES = ['Microsoft/Credentials', 'Microsoft/Protect', 'Microsoft/Vault']

const locations: Record<BuddyPlatformId, SensitiveLocations> = {
  darwin: {
    absolute: ['/private/etc/sudoers', '/Library/Keychains', '/private/var/db/dslocal'],
    environment: [
      { key: 'HOME', homeFallback: '.', paths: ['Library/Keychains', 'Library/Safari', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium', 'Library/Application Support/Firefox', '.config/gcloud'] },
    ],
  },
  linux: {
    absolute: ['/etc/shadow', '/etc/sudoers'],
    environment: [
      { key: 'XDG_CONFIG_HOME', homeFallback: '.config', paths: ['gcloud', 'google-chrome', 'chromium'] },
      { key: 'XDG_DATA_HOME', homeFallback: '.local/share', paths: ['keyrings'] },
    ],
  },
  win32: {
    absolute: [],
    environment: [
      {
        key: 'APPDATA',
        homeFallback: 'AppData/Roaming',
        paths: [...WINDOWS_CREDENTIAL_DIRECTORIES, 'gcloud', 'Mozilla/Firefox'],
      },
      {
        key: 'LOCALAPPDATA',
        homeFallback: 'AppData/Local',
        paths: [...WINDOWS_CREDENTIAL_DIRECTORIES, 'Google/Chrome/User Data', 'Microsoft/Edge/User Data', 'Chromium/User Data', 'BraveSoftware/Brave-Browser/User Data'],
      },
      { key: 'SystemRoot', paths: ['System32/config'] },
    ],
  },
}

export function resolveSensitiveLocations(home: string | null, environment: NodeJS.ProcessEnv): string[] {
  const definition = locations[currentPlatform.id]
  const normalize = (name: string) => currentPlatform.id === 'win32' ? name.toUpperCase() : name
  const inherited = new Map(Object.entries(environment).map(([name, value]) => [normalize(name), value]))
  const get = (name: string) => inherited.get(normalize(name))
  const roots = [...definition.absolute]
  const buddyHome = get('LEXORA_BUDDY_HOME')
  if (buddyHome && filePaths.path.isAbsolute(buddyHome)) {
    roots.push(...['secrets', '../device', '../storage.json'].map(path => filePaths.resolveInput(path, buddyHome)))
  }
  const protection = get('LEXORA_BUDDY_STORAGE_PROTECTION')
  const storageProtection: unknown = protection ? JSON.parse(protection) : []
  if (!Array.isArray(storageProtection) || !storageProtection.every(root => typeof root === 'string' && filePaths.path.isAbsolute(root)))
    throw new Error('STORAGE_INVALID_PROTECTION')
  roots.push(...storageProtection)
  for (const source of [
    ...definition.environment,
    { key: 'CARGO_HOME', homeFallback: '.cargo', paths: ['credentials', 'credentials.toml'] },
  ]) {
    const bases = [get(source.key), home && source.homeFallback ? filePaths.path.join(home, source.homeFallback) : null]
    for (const base of bases) {
      if (!base)
        continue
      try {
        const directory = filePaths.resolveInput(base)
        roots.push(...source.paths.map(path => filePaths.resolveInput(path, directory)))
      }
      catch {
        continue
      }
    }
  }
  const npmConfig = get('NPM_CONFIG_USERCONFIG') ?? get('npm_config_userconfig')
  if (npmConfig && filePaths.path.isAbsolute(npmConfig))
    roots.push(npmConfig)
  return roots
}
