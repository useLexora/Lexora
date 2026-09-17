import { Buffer } from 'node:buffer'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLocalNamedPipe as isWindowsPipe } from '../../../shared/platform/localEndpoint'
import { resolveBuddyRuntimePaths } from '../paths'

const BASE_OPTIONS = {
  defaultUserData: '/home/lexora/.config/Lexora Buddy',
  desktopName: 'site.haohaoxue.LexoraBuddy',
  isPackaged: false,
  platform: 'linux',
  temporaryDirectory: '/tmp',
  userHome: '/home/lexora',
  userId: 1000,
  xdgCacheHome: '/var/cache/user',
  xdgConfigHome: '/var/config/user',
  xdgRuntimeDirectory: '/run/user/1000',
  xdgStateHome: '/var/state/user',
} as const

describe('resolveBuddyRuntimePaths', () => {
  it('isolates macOS profiles and bounds Unix socket paths independently of long temporary paths', () => {
    const options = { ...BASE_OPTIONS, platform: 'darwin', userHome: '/Users/lexora', defaultUserData: '/Users/lexora/Library/Application Support/Lexora Buddy', temporaryDirectory: `/private/var/folders/${'a'.repeat(120)}` } as const
    const stable = resolveBuddyRuntimePaths({ ...options, isPackaged: true })
    const development = resolveBuddyRuntimePaths(options)
    const firstTest = resolveBuddyRuntimePaths({ ...options, smokeTest: true, lexoraHomeOverride: '/private/tmp/first' })
    const secondTest = resolveBuddyRuntimePaths({ ...options, smokeTest: true, lexoraHomeOverride: '/private/tmp/second' })
    expect(stable.userData).toBe(options.defaultUserData)
    expect(stable.sessionData).toBe('/Users/lexora/Library/Caches/lexora-buddy/chromium')
    expect(new Set([stable, development, firstTest, secondTest].map(paths => paths.browserAdapterSocket)).size).toBe(4)
    for (const paths of [stable, development, firstTest, secondTest]) {
      expect(Buffer.byteLength(paths.browserAdapterSocket, 'utf8')).toBeLessThanOrEqual(100)
      expect(paths.nativePetSocket).toBeNull()
    }
    expect(development.userData).not.toBe(stable.userData)
    expect(firstTest.sessionData).toBe('/private/tmp/first/.runtime/cache/chromium')
    expect(firstTest.logs).toBe('/private/tmp/first/.runtime/state/logs')
  })

  it('isolates interactive development from the installed application', () => {
    expect(resolveBuddyRuntimePaths(BASE_OPTIONS)).toEqual({
      agentDirectory: '/home/lexora/.lexora-dev/buddy/agent',
      appName: 'Lexora Buddy Dev',
      browserAdapterSocket: '/run/user/1000/lexora-buddy-dev/browser-adapter.sock',
      buddyHome: '/home/lexora/.lexora-dev/buddy',
      configPath: '/home/lexora/.lexora-dev/config.toml',
      crashDumps: '/var/state/user/lexora-buddy-dev/crashes',
      desktopName: 'site.haohaoxue.LexoraBuddy.Development',
      iconVariant: 'development',
      lexoraHome: '/home/lexora/.lexora-dev',
      logs: '/var/state/user/lexora-buddy-dev/logs',
      namespace: 'lexora-buddy-dev',
      nativePetSocket: '/run/user/1000/lexora-buddy-dev/native-pet.sock',
      nativePetState: '/var/state/user/lexora-buddy-dev/pet-state.json',
      profile: 'development',
      sessionData: '/var/cache/user/lexora-buddy-dev/chromium',
      userData: '/var/config/user/lexora-buddy-dev/electron',
      windowState: '/var/state/user/lexora-buddy-dev/window-state.json',
    })
  })

  it('preserves the installed application paths and Electron userData', () => {
    expect(resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      isPackaged: true,
    })).toEqual({
      agentDirectory: '/home/lexora/.lexora/buddy/agent',
      appName: 'Lexora Buddy',
      browserAdapterSocket: '/run/user/1000/lexora-buddy/browser-adapter.sock',
      buddyHome: '/home/lexora/.lexora/buddy',
      configPath: '/home/lexora/.lexora/config.toml',
      crashDumps: '/var/state/user/lexora-buddy/crashes',
      desktopName: 'site.haohaoxue.LexoraBuddy',
      iconVariant: 'stable',
      lexoraHome: '/home/lexora/.lexora',
      logs: '/var/state/user/lexora-buddy/logs',
      namespace: 'lexora-buddy',
      nativePetSocket: '/run/user/1000/lexora-buddy/native-pet.sock',
      nativePetState: '/var/state/user/lexora-buddy/pet-state.json',
      profile: 'stable',
      sessionData: '/var/cache/user/lexora-buddy/chromium',
      userData: '/home/lexora/.config/Lexora Buddy',
      windowState: '/var/state/user/lexora-buddy/window-state.json',
    })
  })

  it('falls back from invalid XDG directories without crossing profile namespaces', () => {
    const paths = resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      xdgCacheHome: 'relative-cache',
      xdgConfigHome: 'relative-config',
      xdgRuntimeDirectory: 'relative-runtime',
      xdgStateHome: undefined,
    })

    expect(paths.sessionData).toBe('/home/lexora/.cache/lexora-buddy-dev/chromium')
    expect(paths.userData).toBe('/home/lexora/.config/lexora-buddy-dev/electron')
    expect(paths.logs).toBe('/home/lexora/.local/state/lexora-buddy-dev/logs')
    expect(paths.browserAdapterSocket).toBe('/tmp/lexora-buddy-dev-uid-1000/browser-adapter.sock')
    expect(paths.nativePetSocket).toBe('/tmp/lexora-buddy-dev-uid-1000/native-pet.sock')
  })

  it('keeps smoke-test runtime state inside its required temporary product home', () => {
    expect(resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      isPackaged: true,
      lexoraHomeOverride: '/tmp/lexora-smoke/home',
      nativePetSocketOverride: '/tmp/lexora-smoke/native-pet.sock',
      smokeTest: true,
    })).toEqual({
      agentDirectory: '/tmp/lexora-smoke/home/buddy/agent',
      appName: 'Lexora Buddy Test',
      browserAdapterSocket: '/tmp/lexora-smoke/home/.runtime/browser-adapter.sock',
      buddyHome: '/tmp/lexora-smoke/home/buddy',
      configPath: '/tmp/lexora-smoke/home/config.toml',
      crashDumps: '/tmp/lexora-smoke/home/.runtime/state/crashes',
      desktopName: 'site.haohaoxue.LexoraBuddy.Test',
      iconVariant: 'stable',
      lexoraHome: '/tmp/lexora-smoke/home',
      logs: '/tmp/lexora-smoke/home/.runtime/state/logs',
      namespace: 'lexora-buddy-test',
      nativePetSocket: '/tmp/lexora-smoke/native-pet.sock',
      nativePetState: '/tmp/lexora-smoke/home/.runtime/state/pet-state.json',
      profile: 'test',
      sessionData: '/tmp/lexora-smoke/home/.runtime/cache/chromium',
      userData: '/tmp/lexora-smoke/home/.runtime/electron',
      windowState: '/tmp/lexora-smoke/home/.runtime/state/window-state.json',
    })
  })

  it('honors explicit absolute development overrides', () => {
    const paths = resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      lexoraHomeOverride: '/tmp/lexora-home',
      nativePetStateOverride: '/tmp/pet-state.json',
      profileOverride: 'development',
      userDataOverride: '/tmp/electron-user-data',
    })

    expect(paths.lexoraHome).toBe('/tmp/lexora-home')
    expect(paths.nativePetState).toBe('/tmp/pet-state.json')
    expect(paths.userData).toBe('/tmp/electron-user-data')
  })

  it('maps long test roots to a stable short socket directory', () => {
    const lexoraHome = `/tmp/${'deep-browser-run/'.repeat(12)}`
    const paths = resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      lexoraHomeOverride: lexoraHome,
      profileOverride: 'test',
    })

    expect(paths.browserAdapterSocket).toMatch(
      /^\/tmp\/lexora-buddy-test-[\da-f]{16}\/browser-adapter\.sock$/,
    )
    expect(dirname(paths.nativePetSocket!)).toBe(dirname(paths.browserAdapterSocket))
    expect(Buffer.byteLength(paths.browserAdapterSocket, 'utf8')).toBeLessThanOrEqual(100)
    expect(paths.sessionData).toBe(`${lexoraHome}.runtime/cache/chromium`)
    expect(paths.userData).toBe(`${lexoraHome}.runtime/electron`)
  })

  it('rejects unsafe profile and path overrides', () => {
    expect(() => resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      profileOverride: 'preview',
    })).toThrow('LEXORA_BUDDY_PROFILE must be stable, development, or test')
    expect(() => resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      lexoraHomeOverride: '../lexora',
    })).toThrow('LEXORA_HOME must be an absolute path')
    expect(() => resolveBuddyRuntimePaths({
      ...BASE_OPTIONS,
      profileOverride: 'test',
    })).toThrow('LEXORA_HOME is required for the test profile')
  })

  it('isolates Windows profiles and uses named pipes without pet paths', () => {
    const options = {
      ...BASE_OPTIONS,
      defaultUserData: 'C:\\Users\\测试 User\\AppData\\Roaming\\Lexora Buddy',
      localAppData: 'C:\\Users\\测试 User\\AppData\\Local',
      platform: 'win32' as const,
      temporaryDirectory: 'C:\\Temp',
      userHome: 'C:\\Users\\测试 User',
    }
    const stable = resolveBuddyRuntimePaths({ ...options, isPackaged: true })
    const development = resolveBuddyRuntimePaths(options)
    const test = resolveBuddyRuntimePaths({
      ...options,
      profileOverride: 'test',
      lexoraHomeOverride: 'C:\\Temp\\隔离 Test',
    })
    expect(stable.buddyHome).toBe('C:\\Users\\测试 User\\.lexora\\buddy')
    expect(stable.agentDirectory).toBe('C:\\Users\\测试 User\\.lexora\\buddy\\agent')
    expect(stable.logs).toBe('C:\\Users\\测试 User\\AppData\\Local\\Lexora Buddy\\state\\logs')
    expect(development.buddyHome).toBe('C:\\Users\\测试 User\\.lexora-dev\\buddy')
    expect(test.userData).toBe('C:\\Temp\\隔离 Test\\.runtime\\electron')
    expect(new Set([stable.browserAdapterSocket, development.browserAdapterSocket, test.browserAdapterSocket]).size).toBe(3)
    for (const paths of [stable, development, test]) {
      expect(isWindowsPipe(paths.browserAdapterSocket)).toBe(true)
      expect(paths.nativePetSocket).toBeNull()
      expect(paths.nativePetState).toBeNull()
    }
    const secondTest = resolveBuddyRuntimePaths({
      ...options,
      profileOverride: 'test',
      lexoraHomeOverride: 'C:\\Temp\\Second Test',
    })
    expect(secondTest.browserAdapterSocket).not.toBe(test.browserAdapterSocket)
  })
})
