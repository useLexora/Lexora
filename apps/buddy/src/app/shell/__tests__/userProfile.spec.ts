import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import { describe, expect, it } from 'vitest'
import { extractInitials, getDeterministicAvatarColor, resolveUserProfile } from '../userProfile'

describe('userProfile', () => {
  it('extracts initials correctly for Latin, CJK, hyphenated, and edge cases', () => {
    expect(extractInitials('shanyuhai')).toBe('S')
    expect(extractInitials('Shan Yuhai')).toBe('SY')
    expect(extractInitials('山与海')).toBe('山')
    expect(extractInitials('john-doe')).toBe('JD')
    expect(extractInitials('@alex')).toBe('A')
    expect(extractInitials('')).toBe('U')
    expect(extractInitials('   ')).toBe('U')
  })

  it('generates deterministic color from name', () => {
    const color1 = getDeterministicAvatarColor('shanyuhai')
    const color2 = getDeterministicAvatarColor('shanyuhai')
    expect(color1).toBe(color2)
    expect(color1).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('resolves defaults from system profile when custom profile is empty', () => {
    const appInfo = {
      capabilities: {},
      chromiumVersion: '120.0',
      configPath: '/home/test/.lexora/config.toml',
      electronVersion: '28.0',
      nodeVersion: '20.0',
      platform: 'linux',
      systemProfile: {
        avatarUrl: 'data:image/png;base64,system-icon',
        displayName: 'Test User',
        hostname: 'my-desktop',
        username: 'testuser',
      },
      version: '1.0.0',
    } as unknown as DesktopAppInfo

    const resolved = resolveUserProfile({}, appInfo)

    expect(resolved.userName).toBe('Test User')
    expect(resolved.deviceName).toBe('my-desktop')
    expect(resolved.avatarUrl).toBe('data:image/png;base64,system-icon')
    expect(resolved.initials).toBe('TU')
    expect(resolved.isCustomUserName).toBe(false)
    expect(resolved.isCustomDeviceName).toBe(false)
    expect(resolved.isCustomAvatar).toBe(false)
    expect(resolved.systemAvatarUrl).toBe('data:image/png;base64,system-icon')
    expect(resolved.systemUsername).toBe('testuser')
  })

  it('prefers custom profile overrides over system defaults', () => {
    const appInfo = {
      capabilities: {},
      chromiumVersion: '120.0',
      configPath: '/home/test/.lexora/config.toml',
      electronVersion: '28.0',
      nodeVersion: '20.0',
      platform: 'linux',
      systemProfile: {
        avatarUrl: 'data:image/png;base64,system-icon',
        displayName: 'Test User',
        hostname: 'my-desktop',
        username: 'testuser',
      },
      version: '1.0.0',
    } as unknown as DesktopAppInfo

    const resolved = resolveUserProfile({
      avatar: 'data:image/png;base64,custom-avatar',
      deviceName: 'Office Machine',
      userName: 'Alice',
    }, appInfo)

    expect(resolved.userName).toBe('Alice')
    expect(resolved.deviceName).toBe('Office Machine')
    expect(resolved.avatarUrl).toBe('data:image/png;base64,custom-avatar')
    expect(resolved.systemAvatarUrl).toBe('data:image/png;base64,system-icon')
    expect(resolved.initials).toBe('A')
    expect(resolved.isCustomUserName).toBe(true)
    expect(resolved.isCustomDeviceName).toBe(true)
    expect(resolved.isCustomAvatar).toBe(true)
  })

  it('falls back safely when appInfo is not yet available', () => {
    const resolved = resolveUserProfile(null, null)

    expect(resolved.userName).toBe('User')
    expect(resolved.deviceName).toBe('Desktop')
    expect(resolved.avatarUrl).toBeNull()
    expect(resolved.initials).toBe('U')
    expect(resolved.platform).toBe('linux')
    expect(resolved.systemAvatarUrl).toBeNull()
  })
})
