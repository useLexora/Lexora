import { userInfo } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSandboxEnvironment, createWindowsSandboxEnvironment } from '../sandboxEnvironment'

describe('sandbox environment', () => {
  it.each(['linux', 'darwin'] as const)('preserves user and XDG locations while privatizing temporary files on %s', (platform) => {
    const source = Object.freeze({
      HOME: '/fixture/user home',
      XDG_CONFIG_HOME: '/fixture/config',
      XDG_DATA_HOME: '/fixture/data',
      XDG_CACHE_HOME: '/fixture/cache',
      XDG_STATE_HOME: '/fixture/state',
      USER: 'fixture',
      LOGNAME: 'fixture',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC',
      PATH: '/host/untrusted/bin',
      TMPDIR: '/host/tmp',
      TEMP: '/host/temp',
      TMP: '/host/tmp',
      TERM: 'xterm',
    })

    expect(createSandboxEnvironment(source, '/fixture/private', platform)).toEqual({
      HOME: source.HOME,
      XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
      XDG_DATA_HOME: source.XDG_DATA_HOME,
      XDG_CACHE_HOME: source.XDG_CACHE_HOME,
      XDG_STATE_HOME: source.XDG_STATE_HOME,
      USER: 'fixture',
      LOGNAME: 'fixture',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC',
      PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
      TMPDIR: join('/fixture/private', 'tmp'),
      TERM: 'dumb',
    })
  })

  it.each(['linux', 'darwin'] as const)('uses the real home fallback and leaves unset XDG paths to tool defaults on %s', (platform) => {
    for (const home of [undefined, '']) {
      expect(createSandboxEnvironment({ HOME: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: undefined }, '/fixture/private', platform)).toEqual({
        HOME: userInfo().homedir,
        TMPDIR: join('/fixture/private', 'tmp'),
        PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
        LANG: 'C.UTF-8',
        TERM: 'dumb',
      })
    }
  })

  it('resolves the OS home even when the parent process HOME is empty', () => {
    vi.stubEnv('HOME', '')
    try {
      expect(createSandboxEnvironment({ HOME: '' }, '/fixture/private', 'linux').HOME).toBe(userInfo().homedir)
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([undefined, '', 'D:\\Git home'])('preserves case-insensitive Windows user directories and falls back from HOME=%s', (home) => {
    expect(createSandboxEnvironment({
      SystemRoot: 'C:\\Windows',
      UserProfile: 'C:\\Users\\Fixture',
      AppData: 'D:\\Roaming',
      LocalAppData: 'D:\\Local',
      HomeDrive: 'H:',
      HomePath: '\\Fixture',
      UserName: 'Fixture',
      Home: home,
      Temp: 'C:\\host-temp',
      Tmp: 'C:\\host-tmp',
      Path: 'C:\\untrusted',
    }, 'D:\\private', 'win32')).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\Fixture',
      HOME: home || 'C:\\Users\\Fixture',
      APPDATA: 'D:\\Roaming',
      LOCALAPPDATA: 'D:\\Local',
      HOMEDRIVE: 'H:',
      HOMEPATH: '\\Fixture',
      USERNAME: 'Fixture',
      TEMP: 'D:\\private\\tmp',
      TMP: 'D:\\private\\tmp',
      PATH: 'C:\\Windows\\System32',
    })
  })

  it.each([
    {},
    { SystemRoot: 'C:\\Windows' },
    { UserProfile: 'C:\\Users\\Fixture' },
  ])('rejects missing Windows system or user directory: %j', (source) => {
    expect(() => createSandboxEnvironment(source, 'D:\\private', 'win32'))
      .toThrow('Windows system or user directory is unavailable')
  })

  it.each(['linux', 'darwin', 'win32'] as const)('drops ambient secrets, injection, session and proxy settings on %s', (platform) => {
    const source = {
      HOME: '/fixture/home',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\Fixture',
      MISE_API_TOKEN: 'synthetic-secret',
      UNKNOWN_SECRET: 'synthetic-secret',
      NODE_OPTIONS: '--require=/fixture/inject.js',
      BASH_ENV: '/fixture/startup.sh',
      SHELLOPTS: 'xtrace',
      LD_PRELOAD: '/fixture/inject.so',
      SSH_AUTH_SOCK: '/fixture/ssh.sock',
      DISPLAY: ':1',
      XDG_RUNTIME_DIR: '/run/user/1000',
      HTTP_PROXY: 'http://host.invalid:8080',
      https_proxy: 'http://host.invalid:8081',
      ALL_PROXY: 'socks5://host.invalid:1080',
      no_proxy: '*',
      NODE_USE_ENV_PROXY: '1',
      MISE_DATA_DIR: '() { synthetic; }',
      MISE_CONFIG_DIR: '/fixture/config\0suffix',
    }
    const environment = createSandboxEnvironment(source, '/fixture/private', platform)
    const { HOME, SystemRoot, USERPROFILE, ...excluded } = source
    for (const name of Object.keys(excluded))
      expect(environment, name).not.toHaveProperty(name)
    expect(environment.HOME).toBe(HOME)
    if (platform === 'win32') {
      expect(environment.SystemRoot).toBe(SystemRoot)
      expect(environment.USERPROFILE).toBe(USERPROFILE)
    }
  })

  it.each([undefined, 'http://127.0.0.1:3128'])('uses controlled Windows paths and only an explicitly supplied proxy (%s)', (proxyUrl) => {
    const options = {
      shell: 'D:\\PowerShell\\pwsh.exe',
      systemRoot: 'D:\\Windows',
      privateRoot: 'D:\\private',
      path: 'D:\\controlled-bin;D:\\Windows\\System32',
      proxyUrl,
    }
    expect(createWindowsSandboxEnvironment({
      SystemRoot: 'C:\\Windows',
      UserProfile: 'C:\\Users\\Fixture',
      Path: 'C:\\untrusted',
      PSModulePath: 'C:\\untrusted-modules',
      ComSpec: 'C:\\untrusted.exe',
      PATHEXT: '.UNTRUSTED',
      HTTP_PROXY: 'http://host.invalid:8080',
      https_proxy: 'http://host.invalid:8081',
      ALL_PROXY: 'socks5://host.invalid:1080',
      NO_PROXY: '*',
      no_proxy: '*',
      NODE_USE_ENV_PROXY: '1',
    }, options)).toEqual({
      SystemRoot: options.systemRoot,
      WINDIR: options.systemRoot,
      USERPROFILE: 'C:\\Users\\Fixture',
      HOME: 'C:\\Users\\Fixture',
      TEMP: win32.join(options.privateRoot, 'tmp'),
      TMP: win32.join(options.privateRoot, 'tmp'),
      PATH: options.path,
      ComSpec: 'D:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PSModulePath: 'D:\\PowerShell\\Modules',
      POWERSHELL_TELEMETRY_OPTOUT: '1',
      ...(proxyUrl
        ? {
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            ALL_PROXY: proxyUrl,
            NO_PROXY: 'localhost,127.0.0.1,::1',
            NODE_USE_ENV_PROXY: '1',
          }
        : {}),
    })
  })
})
