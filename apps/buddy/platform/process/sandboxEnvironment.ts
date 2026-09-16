import { delimiter, dirname, join } from 'node:path'
import process from 'node:process'

export function createWindowsSandboxEnvironment(options: { shell: string, systemRoot: string, privateRoot: string, path: string, proxyUrl?: string }): Record<string, string> {
  const home = join(options.privateRoot, 'home')
  const temporary = join(options.privateRoot, 'tmp')
  return {
    SystemRoot: options.systemRoot,
    WINDIR: options.systemRoot,
    ComSpec: join(options.systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: options.path,
    PSModulePath: join(dirname(options.shell), 'Modules'),
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: temporary,
    TMP: temporary,
    ...(options.proxyUrl ? { HTTP_PROXY: options.proxyUrl, HTTPS_PROXY: options.proxyUrl, ALL_PROXY: options.proxyUrl, NO_PROXY: '', NODE_USE_ENV_PROXY: '1' } : {}),
  }
}

export function createSandboxEnvironment(source: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    const systemRoot = source.SystemRoot ?? source.SYSTEMROOT
    if (!systemRoot)
      throw new Error('Windows system directory is unavailable')
    return {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      USERPROFILE: source.USERPROFILE,
      LOCALAPPDATA: source.LOCALAPPDATA,
      APPDATA: source.APPDATA,
      TEMP: join(directory, 'tmp'),
      TMP: join(directory, 'tmp'),
      PATH: join(systemRoot, 'System32'),
    }
  }
  return {
    HOME: join(directory, 'home'),
    TMPDIR: join(directory, 'tmp'),
    XDG_CACHE_HOME: join(directory, 'home', '.cache'),
    XDG_CONFIG_HOME: join(directory, 'home', '.config'),
    XDG_DATA_HOME: join(directory, 'home', '.local', 'share'),
    PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    LANG: source.LANG || 'C.UTF-8',
    ...(source.LC_ALL ? { LC_ALL: source.LC_ALL } : {}),
    ...(source.TZ ? { TZ: source.TZ } : {}),
    TERM: 'dumb',
  }
}
