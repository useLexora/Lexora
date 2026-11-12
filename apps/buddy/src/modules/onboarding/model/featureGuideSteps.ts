import type { FeatureGuideId } from '@buddy-shared/onboarding/featureDiscovery'

const inlineBeacon = { side: 'right', align: 'center', offsetX: 12 } as const

const targets = {
  'task-archive': [
    { id: 'task-archive', selector: '.desktop-settings-page:has([data-testid="task-archive-manager"]) .desktop-settings-page__title', title: 'discovery.task-archive.title', description: 'discovery.task-archive.hint', beacon: inlineBeacon, side: 'bottom', align: 'start' },
    { id: 'task-archive-cleanup', selector: '#archive-cleanup-policy', title: 'discovery.task-archive-cleanup.title', description: 'discovery.task-archive-cleanup.hint', beacon: { side: 'left', align: 'center', offsetX: -12 }, side: 'bottom', align: 'end' },
  ],
  'chinese-input-triggers': [
    { id: 'chinese-input-triggers', selector: '[data-testid="chinese-input-triggers-setting"] [role="switch"]', title: 'discovery.chinese-input-triggers.title', description: 'discovery.chinese-input-triggers.hint', beacon: { side: 'left', align: 'center', offsetX: -12 }, side: 'left', align: 'center' },
  ],
  'codemode-concurrency': [
    { id: 'codemode-concurrency', selector: '[data-testid="codemode-concurrency-setting"] .desktop-segmented-control', title: 'discovery.codemode-concurrency.title', description: 'discovery.codemode-concurrency.hint', beacon: inlineBeacon, side: 'bottom', align: 'start' },
  ],
  'follow-up-behavior': [
    { id: 'follow-up-behavior', selector: '[data-testid="follow-up-behavior-setting"] .desktop-segmented-control', title: 'discovery.follow-up-behavior.title', description: 'discovery.follow-up-behavior.hint', beacon: inlineBeacon, side: 'top', align: 'end' },
  ],
  'speech-settings': [
    { id: 'speech-settings', selector: '[data-testid="speech-output-settings"] h3', title: 'discovery.speech-settings.title', description: 'discovery.speech-settings.hint', beacon: inlineBeacon, side: 'bottom', align: 'start' },
  ],
  'image-settings': [
    { id: 'image-settings', selector: '[data-image-settings] > h2', title: 'discovery.image-settings.title', description: 'discovery.image-settings.hint', beacon: inlineBeacon, side: 'bottom', align: 'start' },
  ],
  'navigation-layout': [
    { id: 'navigation-layout', selector: '.desktop-navigation-layout-settings', title: 'discovery.navigation-layout.title', description: 'discovery.navigation-layout.hint', side: 'bottom', align: 'center' },
  ],
  'additional-directories': [
    { id: 'additional-directories', selector: '[data-row-key="section:spaces"]', title: 'discovery.additional-directories.title', description: 'discovery.additional-directories.hint', side: 'right', align: 'start' },
  ],
  'network-permissions': [
    { id: 'network-permissions', selector: '[data-testid="network-permissions"]', title: 'discovery.network-permissions.title', description: 'discovery.network-permissions.hint', side: 'left', align: 'start' },
  ],
  'npc-team': [
    { id: 'npc-team', selector: '.buddy-npc-team-toggle', title: 'discovery.npc-team.title', description: 'discovery.npc-team.hint', side: 'top', align: 'end' },
    { id: 'npc-team-save', selector: '.buddy-settings-save', title: 'discovery.npc-team-save.title', description: 'discovery.npc-team-save.hint', side: 'bottom', align: 'end' },
  ],
} as const

export function featureGuideSteps(ids: readonly FeatureGuideId[]) {
  return ids.flatMap(featureId => targets[featureId].map(target => ({
    ...target,
    beacon: 'beacon' in target ? target.beacon : { side: target.side, align: target.align },
    featureId,
  })))
}

export type FeatureGuideStep = ReturnType<typeof featureGuideSteps>[number]
