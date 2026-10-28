import type { FeatureGuideId } from '@buddy-shared/onboarding/featureDiscovery'

const targets = {
  'follow-up-behavior': [
    { id: 'follow-up-behavior', selector: '[data-testid="follow-up-behavior-setting"]', title: 'discovery.follow-up-behavior.title', description: 'discovery.follow-up-behavior.hint', side: 'bottom', align: 'start' },
  ],
  'navigation-layout': [
    { id: 'navigation-layout', selector: '.desktop-navigation-layout-settings', title: 'discovery.navigation-layout.title', description: 'discovery.navigation-layout.hint', side: 'bottom', align: 'center' },
  ],
  'additional-directories': [
    { id: 'additional-directories', selector: '.desktop-task-sidebar__spaces', title: 'discovery.additional-directories.title', description: 'discovery.additional-directories.hint', side: 'right', align: 'start' },
  ],
  'network-permissions': [
    { id: 'network-permissions', selector: '[data-testid="network-permissions"]', title: 'discovery.network-permissions.title', description: 'discovery.network-permissions.hint', side: 'left', align: 'start' },
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
