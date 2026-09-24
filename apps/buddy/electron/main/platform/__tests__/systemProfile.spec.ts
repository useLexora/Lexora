import { describe, expect, it } from 'vitest'
import { clearSystemUserProfileCache, getSystemUserProfile, resolveSystemUserProfile } from '../systemProfile'

describe('systemProfile', () => {
  it('resolves system user profile with username, displayName, hostname and avatarUrl', async () => {
    clearSystemUserProfileCache()
    const profile = await resolveSystemUserProfile()

    expect(typeof profile.username).toBe('string')
    expect(profile.username.length).toBeGreaterThan(0)
    expect(typeof profile.displayName).toBe('string')
    expect(profile.displayName.length).toBeGreaterThan(0)
    expect(typeof profile.hostname).toBe('string')
    expect(profile.hostname.length).toBeGreaterThan(0)
    expect(profile.avatarUrl === null || typeof profile.avatarUrl === 'string').toBe(true)
  })

  it('caches the resolved profile across consecutive getSystemUserProfile calls', async () => {
    clearSystemUserProfileCache()
    const first = await getSystemUserProfile()
    const second = await getSystemUserProfile()

    expect(first).toBe(second)
  })
})
