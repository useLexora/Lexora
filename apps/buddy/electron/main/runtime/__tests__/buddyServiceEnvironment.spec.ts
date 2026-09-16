import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import {
  createBuddyServiceEnvironment,
  resolveBuddySearchToolsDirectory,
} from '../buddyServiceEnvironment'

const executeFile = promisify(execFile)

describe('buddyServiceEnvironment', () => {
  it('replaces all inherited proxy and bypass settings with the application gateway', () => {
    const gateway = 'http://lexora:fixture@127.0.0.1:3128'
    const env = createBuddyServiceEnvironment({ http_proxy: 'http://old.invalid:1', HTTPS_PROXY: 'http://old.invalid:2', NO_PROXY: '*' }, '/tmp/buddy', 'linux', gateway)
    expect(new URL(env.http_proxy!).username).toBe('lexora-http')
    expect(env.HTTPS_PROXY).toBe(`${gateway}/`)
    expect(env.NO_PROXY).toBe('')
    expect(env.no_proxy).toBe('')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
  })
  it.each([
    ['linux', '/repo/apps/buddy', '/opt/buddy/resources', '/opt/buddy/resources/search-tools', '/repo/apps/buddy/.output/build/search-tools/linux-x64'],
    ['win32', 'C:\\源码 空格\\buddy', 'C:\\Apps\\Buddy\\resources', 'C:\\Apps\\Buddy\\resources\\search-tools', 'C:\\源码 空格\\buddy\\.output\\build\\search-tools\\win32-x64'],
  ] as const)('resolves bundled and development binaries for %s without using user data', (platform, appPath, resourcesPath, packaged, development) => {
    const options = { platform, appPath, resourcesPath, architecture: 'x64' }
    expect(resolveBuddySearchToolsDirectory({ ...options, isPackaged: true })).toBe(packaged)
    expect(resolveBuddySearchToolsDirectory({ ...options, isPackaged: false })).toBe(development)
    expect(() => resolveBuddySearchToolsDirectory({ ...options, architecture: 'arm64', isPackaged: true }))
      .toThrow('Unsupported search tools target')
  })

  it('normalizes Windows environment names without leaking credentials', () => {
    const environment = createBuddyServiceEnvironment({
      Home: 'D:\\用户 空格\\Git',
      HomeDrive: 'H:',
      HomePath: '\\Fixture',
      UserName: 'Fixture',
      UserProfile: 'C:\\Users\\Fixture',
      Path: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local',
      AppData: 'C:\\Users\\Fixture\\AppData\\Roaming',
      XDG_CURRENT_DESKTOP: 'KDE',
      TEMP: 'C:\\Temp',
      openai_api_key: 'fixture-secret',
      Unrelated_Secret: 'fixture-secret',
      pi_tools_dir: 'C:\\untrusted-tools',
      No_Proxy: 'localhost',
    }, 'C:\\Users\\Fixture\\.lexora\\buddy', 'win32')
    expect(environment).toEqual({
      HOME: 'D:\\用户 空格\\Git',
      HOMEDRIVE: 'H:',
      HOMEPATH: '\\Fixture',
      USERNAME: 'Fixture',
      USERPROFILE: 'C:\\Users\\Fixture',
      PATH: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local',
      APPDATA: 'C:\\Users\\Fixture\\AppData\\Roaming',
      TEMP: 'C:\\Temp',
      NO_PROXY: 'localhost',
      LEXORA_BUDDY_HOME: 'C:\\Users\\Fixture\\.lexora\\buddy',
      NODE_USE_ENV_PROXY: '1',
      PI_CODING_AGENT_DIR: 'C:\\Users\\Fixture\\.lexora\\buddy\\agent',
    })
  })
  it('preserves Linux user and desktop session environment and excludes ambient credentials', () => {
    const environment = createBuddyServiceEnvironment({
      HOME: '/home/example',
      USER: 'example',
      LOGNAME: 'example',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CURRENT_DESKTOP: 'KDE',
      KDE_SESSION_VERSION: '6',
      DESKTOP_SESSION: 'plasma',
      OPENAI_API_KEY: 'sk-host-secret',
      GH_TOKEN: 'fixture-github-secret',
      GITHUB_TOKEN: 'fixture-github-secret',
      PATH: '/usr/bin',
      UNRELATED_SECRET: 'host-secret',
    }, '/data/lexora/buddy', 'linux')

    expect(environment).toEqual({
      HOME: '/home/example',
      USER: 'example',
      LOGNAME: 'example',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CURRENT_DESKTOP: 'KDE',
      KDE_SESSION_VERSION: '6',
      DESKTOP_SESSION: 'plasma',
      LEXORA_BUDDY_HOME: '/data/lexora/buddy',
      NODE_USE_ENV_PROXY: '1',
      PI_CODING_AGENT_DIR: '/data/lexora/buddy/agent',
      PATH: '/usr/bin',
    })
  })

  it.each([undefined, ''])('uses the main process home when Linux HOME is %s', (userHome) => {
    const environment = createBuddyServiceEnvironment({ HOME: userHome }, '/data/lexora/buddy', 'linux')

    expect(environment.HOME).toBe(homedir())
  })

  it.skipIf(process.platform !== 'linux')('lets shell commands read the existing Git identity from user HOME', async () => {
    const root = await createTemporaryDirectory('buddy-git-environment-')
    const userHome = join(root, 'user home')
    await mkdir(userHome)
    await writeFile(join(userHome, '.gitconfig'), '[user]\n\tname = Buddy Fixture\n\temail = buddy@example.invalid\n')
    const environment = createBuddyServiceEnvironment({
      HOME: userHome,
      PATH: process.env.PATH,
    }, join(root, 'buddy'), 'linux')

    const { stdout } = await executeFile('bash', ['-c', 'git var GIT_AUTHOR_IDENT'], {
      cwd: root,
      env: environment,
      timeout: 5000,
    })

    expect(stdout).toMatch(/^Buddy Fixture <buddy@example\.invalid> \d+ [+-]\d{4}\n$/)
  })

  describe.skipIf(process.platform !== 'win32')('windows Git user directory', () => {
    it.each(['HOME', 'HOMEDRIVE_HOMEPATH', 'USERPROFILE_FALLBACK'])('preserves Git identity resolution through %s', async (homeSource) => {
      const root = await createTemporaryDirectory('buddy-windows-git-environment-')
      const userHome = join(root, 'Git home')
      const profile = join(root, 'profile')
      await mkdir(userHome)
      await mkdir(profile)
      await writeFile(join(userHome, '.gitconfig'), '[user]\n\tname = Buddy Fixture\n\temail = buddy@example.invalid\n')
      const drive = win32.parse(userHome).root.slice(0, -1)
      const homeShare = homeSource === 'HOMEDRIVE_HOMEPATH' ? userHome : join(root, 'unavailable-home')
      const environment = createBuddyServiceEnvironment({
        ...process.env,
        HOME: homeSource === 'HOME' ? userHome : undefined,
        HOMEDRIVE: drive,
        HOMEPATH: homeShare.slice(drive.length),
        USERPROFILE: homeSource === 'USERPROFILE_FALLBACK' ? userHome : profile,
      }, join(root, 'buddy'), 'win32')

      const { stdout } = await executeFile('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'git var GIT_AUTHOR_IDENT; exit $LASTEXITCODE',
      ], {
        cwd: root,
        env: environment,
        timeout: 10_000,
        windowsHide: true,
      })

      expect(stdout.trim()).toMatch(/^Buddy Fixture <buddy@example\.invalid> \d+ [+-]\d{4}$/)
    }, 15_000)
  })
})
