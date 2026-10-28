import { eq, gt, lte, valid } from 'semver'
import { z } from 'zod'

export const FEATURE_GUIDES = [
  { id: 'navigation-layout', version: '0.14.0' },
  { id: 'npc-team', version: '0.14.0' },
  { id: 'additional-directories', version: '0.15.0' },
  { id: 'network-permissions', version: '0.15.0' },
  { id: 'follow-up-behavior', version: '0.18.0' },
] as const

export type FeatureGuideId = typeof FEATURE_GUIDES[number]['id']
export interface FeatureGuide { id: FeatureGuideId, version: string }

const ids = z.array(z.string().min(1).max(100)).max(512)
export const featureDiscoverySchema = z.object({
  version: z.string().max(80).refine(value => value === '' || !!valid(value)),
  pending: ids,
  notified: ids,
}).strict()
export type FeatureDiscoveryState = z.infer<typeof featureDiscoverySchema>
export const EMPTY_FEATURE_DISCOVERY: FeatureDiscoveryState = { version: '', pending: [], notified: [] }

export function availableFeatureGuides(version: string) {
  return valid(version) ? FEATURE_GUIDES.filter(feature => lte(feature.version, version)) : []
}

export function advanceFeatureDiscovery(state: FeatureDiscoveryState, version: string, firstRun: boolean, features: readonly { id: string, version: string }[] = FEATURE_GUIDES): FeatureDiscoveryState {
  if (!valid(version) || (state.version && !gt(version, state.version)))
    return state
  const added = firstRun
    ? []
    : features.filter(feature => lte(feature.version, version)
      && (state.version ? gt(feature.version, state.version) : eq(feature.version, version)))
  return {
    version,
    pending: [...new Set([...state.pending, ...added.map(feature => feature.id)])],
    notified: [...state.notified],
  }
}
