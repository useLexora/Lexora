import { describe, expect, it } from 'vitest'
import { BUDDY_FEATURES, describeBuddyCapabilities, resolveBuddyPlatform } from '..'

describe('buddy platform composition', () => {
  it('omits the entire native pet contribution from Windows', () => {
    const windows = resolveBuddyPlatform('win32')
    const features = windows.features.map(id => BUDDY_FEATURES[id])
    expect(features.flatMap(feature => feature.tools)).toEqual(['lexora_system_action'])
    expect(features.flatMap(feature => feature.skills)).toEqual([])
    expect(features.map(feature => feature.settingsCategory)).not.toContain('pet')
    expect(describeBuddyCapabilities(windows).shell).toBe('powershell')
  })
})
