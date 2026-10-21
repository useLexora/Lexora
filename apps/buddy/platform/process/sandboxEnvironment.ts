import { userInfo } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import process from 'node:process'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { createToolchainEnvironment } from './toolchainEnvironment'

export const SANDBOX_LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'

export function createWindowsSandboxEnvironment(source: NodeJS.ProcessEnv, options: { shell: string, systemRoot: string, privateRoot: string, path: string, proxyUrl?: string }): Record<string, string> {
  return {
    ...createSandboxEnvironment(source, options.privateRoot, OPERATING_SYSTEM.Windows),
    SystemRoot: options.systemRoot,
    WINDIR: options.systemRoot,
    ComSpec: win32.join(options.systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: options.path,
    PSModulePath: win32.join(win32.dirname(options.shell), 'Modules'),
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    ...(options.proxyUrl ? { HTTP_PROXY: options.proxyUrl, HTTPS_PROXY: options.proxyUrl, ALL_PROXY: options.proxyUrl, NO_PROXY: SANDBOX_LOOPBACK_NO_PROXY, NODE_USE_ENV_PROXY: '1' } : {}),
  }
}

export function createSandboxEnvironment(source: NodeJS.ProcessEnv, directory: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const environment = createToolchainEnvironment(source, platform)
  if (platform === OPERATING_SYSTEM.Windows) {
    const inherited = Object.fromEntries(Object.entries(source).map(([name, value]) => [name.toUpperCase(), value]))
    const systemRoot = inherited.SYSTEMROOT
    const userProfile = inherited.USERPROFILE
    if (!systemRoot || !userProfile)
      throw new Error('Windows system or user directory is unavailable')
    for (const name of ['APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME']) {
      if (inherited[name])
        environment[name] = inherited[name]
    }
    return {
      ...environment,
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      HOME: inherited.HOME || userProfile,
      USERPROFILE: userProfile,
      TEMP: win32.join(directory, 'tmp'),
      TMP: win32.join(directory, 'tmp'),
      PATH: win32.join(systemRoot, 'System32'),
    }
  }
  for (const name of ['USER', 'LOGNAME', 'LC_ALL', 'TZ']) {
    if (source[name])
      environment[name] = source[name]
  }
  return {
    ...environment,
    HOME: source.HOME || userInfo().homedir,
    TMPDIR: join(directory, 'tmp'),
    PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    LANG: source.LANG || 'C.UTF-8',
    TERM: 'dumb',
  }
}
