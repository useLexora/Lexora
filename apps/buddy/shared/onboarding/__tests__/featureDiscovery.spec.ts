import { describe, expect, it } from 'vitest'
import { advanceFeatureDiscovery, availableFeatureGuides, EMPTY_FEATURE_DISCOVERY, FEATURE_GUIDES, featureDiscoverySchema } from '../featureDiscovery'

const features = [
  { id: 'layout', version: '0.13.0' },
  { id: 'npc', version: '0.13.1' },
  { id: 'next', version: '0.14.0' },
]

describe('feature discovery across releases', () => {
  it('combines skipped releases without dropping unseen or dismissed items', () => {
    const previous = { version: '0.12.0', pending: ['older'], notified: ['older'] }
    expect(advanceFeatureDiscovery(previous, '0.13.1', false, features)).toEqual({ version: '0.13.1', pending: ['older', 'layout', 'npc'], notified: ['older'] })
    expect(previous).toEqual({ version: '0.12.0', pending: ['older'], notified: ['older'] })
  })

  it('keeps a new installation free of historical reminders', () => {
    expect(advanceFeatureDiscovery(EMPTY_FEATURE_DISCOVERY, '0.14.0', true, features)).toEqual({ version: '0.14.0', pending: [], notified: [] })
  })

  it('introduces only the current release when an old profile has no version history', () => {
    expect(advanceFeatureDiscovery(EMPTY_FEATURE_DISCOVERY, '0.13.1', false, features).pending).toEqual(['npc'])
  })

  it('preserves read state on restart, downgrade and re-upgrade', () => {
    const state = { version: '0.13.1', pending: ['npc'], notified: ['layout', 'npc'] }
    expect(advanceFeatureDiscovery(state, '0.13.1', false, features)).toEqual(state)
    expect(advanceFeatureDiscovery(state, '0.12.0', false, features)).toEqual(state)
    expect(advanceFeatureDiscovery(state, '0.14.0', false, features)).toEqual({ version: '0.14.0', pending: ['npc', 'next'], notified: ['layout', 'npc'] })
  })

  it('uses semantic versions and never introduces unreleased features', () => {
    expect(advanceFeatureDiscovery(EMPTY_FEATURE_DISCOVERY, 'unknown', false, features)).toEqual(EMPTY_FEATURE_DISCOVERY)
    expect(advanceFeatureDiscovery({ version: '0.9.0', pending: [], notified: [] }, '0.13.0-beta.1', false, features).pending).toEqual([])
    const feature = FEATURE_GUIDES[0]
    expect(availableFeatureGuides(feature.version)).toContainEqual(feature)
    expect(availableFeatureGuides(`${feature.version}-beta.1`)).not.toContainEqual(feature)
    expect(featureDiscoverySchema.safeParse({ version: 'invalid', pending: [], notified: [] }).success).toBe(false)
  })
})
