import type { FeatureGuideId } from '@buddy-shared/onboarding/featureDiscovery'

const targets = {
  'navigation-layout': [
    { id: 'navigation-layout', selector: '.desktop-navigation-layout-settings', title: 'discovery.navigation-layout.title', description: 'discovery.navigation-layout.hint', side: 'bottom', align: 'center' },
  ],
  'npc-team': [
    { id: 'npc-team', selector: '.buddy-npc-team-toggle', title: 'discovery.npc-team.title', description: 'discovery.npc-team.hint', side: 'top', align: 'end' },
    { id: 'npc-team-save', selector: '.buddy-settings-save', title: 'discovery.npc-team-save.title', description: 'discovery.npc-team-save.hint', side: 'bottom', align: 'end' },
  ],
} as const

export type FeatureGuideStep = typeof targets[FeatureGuideId][number] & { featureId: FeatureGuideId }

export function featureGuideSteps(ids: readonly FeatureGuideId[]): FeatureGuideStep[] {
  return ids.flatMap(featureId => targets[featureId].map(target => ({ ...target, featureId })))
}
