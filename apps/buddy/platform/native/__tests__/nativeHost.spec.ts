import { describe, expect, it } from 'vitest'
import { createBuddyNativeEnvironment, resolveBuddyPrivateDirectories } from '../nativeHost'

describe('native reader environment', () => {
  it('does not send undefined values to Linux utilityProcess.fork', () => {
    expect(resolveBuddyPrivateDirectories({ platform: 'linux', architecture: 'x64', appPath: '/app', resourcesPath: '/resources', isPackaged: false })).toBeUndefined()
    expect(createBuddyNativeEnvironment({ platform: 'linux', architecture: 'x64', appPath: '/app', resourcesPath: '/resources', isPackaged: false })).toEqual({
      LEXORA_BUDDY_PROCESS_CONTROL: '/app/.output/build/native/x86_64-unknown-linux-gnu/release/lexora-buddy-process-control',
      LEXORA_BUDDY_FILE_READER: '/app/.output/build/native/x86_64-unknown-linux-gnu/release/lexora-buddy-file-reader',
      LEXORA_BUDDY_IMAGE_TRANSFORMER: '/app/.output/build/native/x86_64-unknown-linux-gnu/release/lexora-buddy-image-transform',
    })
  })
  it('uses a fixed packaged Windows executable rather than cwd or ambient PATH', () => {
    expect(resolveBuddyPrivateDirectories({ platform: 'win32', architecture: 'x64', appPath: 'C:\\app\\app.asar', resourcesPath: 'C:\\app\\resources', isPackaged: true })).toBe('C:\\app\\resources\\lexora-service\\resources\\native-host\\lexora-buddy-private-directories.exe')
    expect(createBuddyNativeEnvironment({ platform: 'win32', architecture: 'x64', appPath: 'C:\\app\\app.asar', resourcesPath: 'C:\\app\\resources', isPackaged: true })).toEqual({
      LEXORA_BUDDY_FILE_READER: 'C:\\app\\resources\\lexora-service\\resources\\native-host\\lexora-buddy-file-reader.exe',
      LEXORA_BUDDY_SERVICE_CONTROL: 'C:\\app\\resources\\lexora-service\\resources\\native-host\\lexora-buddy-service-control.exe',
      LEXORA_BUDDY_PROCESS_CONTROL: 'C:\\app\\resources\\lexora-service\\resources\\native-host\\lexora-buddy-process-control.exe',
      LEXORA_BUDDY_RUNTIME_GUARD: 'C:\\app\\resources\\lexora-service\\resources\\native-host\\lexora-buddy-runtime-guard.exe',
      LEXORA_BUDDY_IMAGE_TRANSFORMER: 'C:\\app\\resources\\lexora-service\\resources\\native-image\\lexora-buddy-image-transform.exe',
    })
  })
})

describe('aRM64 native resources', () => {
  it('resolves the same helpers for Desktop and an independently located Core', () => {
    const target = { platform: 'darwin' as const, architecture: 'arm64' }
    const serviceResourcesRoot = '/Applications/Buddy.app/Contents/Resources/lexora-service/resources'
    const core = createBuddyNativeEnvironment({ ...target, serviceResourcesRoot })
    const host = createBuddyNativeEnvironment({ ...target, isPackaged: true, appPath: '/unused', resourcesPath: '/Applications/Buddy.app/Contents/Resources' })
    expect(host).toEqual(core)
    expect(core.LEXORA_BUDDY_FILE_READER).toBe(`${serviceResourcesRoot}/native-host/lexora-buddy-file-reader`)
    expect(createBuddyNativeEnvironment({ ...target, serviceResourcesRoot: '/standalone/resources' }).LEXORA_BUDDY_FILE_READER).toBe('/standalone/resources/native-host/lexora-buddy-file-reader')
  })
  it('selects Linux ARM64 helpers from the target triple', () => {
    const environment = createBuddyNativeEnvironment({ platform: 'linux', architecture: 'arm64', appPath: '/app', resourcesPath: '/resources', isPackaged: false })
    expect(environment.LEXORA_BUDDY_FILE_READER).toBe('/app/.output/build/native/aarch64-unknown-linux-gnu/release/lexora-buddy-file-reader')
    expect(environment.LEXORA_BUDDY_PROCESS_CONTROL).toBe('/app/.output/build/native/aarch64-unknown-linux-gnu/release/lexora-buddy-process-control')
  })

  it('selects Windows ARM64 helpers without x64 emulation', () => {
    const environment = createBuddyNativeEnvironment({ platform: 'win32', architecture: 'arm64', appPath: 'C:\\app', resourcesPath: 'C:\\resources', isPackaged: false })
    expect(environment.LEXORA_BUDDY_FILE_READER).toContain('aarch64-pc-windows-msvc')
    expect(environment.LEXORA_BUDDY_RUNTIME_GUARD).toContain('aarch64-pc-windows-msvc')
  })
})
