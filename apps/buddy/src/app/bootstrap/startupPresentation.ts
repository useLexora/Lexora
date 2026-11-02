import type { ApplicationStartupState } from '@buddy-shared/diagnostics/applicationStartup'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'

type StartupStage = ApplicationStartupState['stages'][number]

const stageLabels: Record<string, BuddyI18nKey> = {
  'runtime.database': 'desktop.loading.database',
  'runtime.event_replay': 'desktop.loading.history',
  'runtime.providers': 'desktop.loading.capabilities',
  'runtime.services': 'desktop.loading.capabilities',
  'renderer': 'desktop.loading.workspace',
}

export function startupPresentation(stages: ApplicationStartupState['stages'], failed = false): { label: BuddyI18nKey, progress: number | null } {
  if (failed || stages.some(stage => stage.status === 'failed'))
    return { label: 'desktop.loading.failed', progress: null }

  const running = stages.filter(stage => stage.status === 'running')
  const active = running.find(stage => stageLabel(stage.stage) && !running.some(other => other.stage.startsWith(`${stage.stage}.`)))
    ?? running.find(stage => stageLabel(stage.stage))
  const label = active ? stageLabel(active.stage)! : 'desktop.loading.app'
  return { label, progress: stageProgress(active) }
}

function stageLabel(stage: string): BuddyI18nKey | undefined {
  return Object.entries(stageLabels).find(([key]) => stage === key || stage.startsWith(`${key}.`))?.[1]
}

function stageProgress(stage?: StartupStage): number | null {
  const progress = stage?.progress
  if (!progress || !Number.isFinite(progress.total) || progress.total <= 0 || !Number.isFinite(progress.completed))
    return null
  return Math.min(1, Math.max(0, progress.completed / progress.total))
}
