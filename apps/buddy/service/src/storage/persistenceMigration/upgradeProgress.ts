import type { StorageReporter } from '../../../../platform/storage/storageTree'
import type { StorageProgress } from '../../../../shared/storage/storageApi'

type Step = NonNullable<StorageProgress['upgradeStep']>

export function reportUpgradeStep(report: StorageReporter | undefined, upgradeStep: Step, items?: StorageProgress['items']) {
  report?.({ phase: upgradeStep === 'sourceFiles' ? 'verifying' : 'converting', upgradeStep, items, files: 0, completedBytes: 0, totalBytes: null, error: null })
}

export function* countedUpgradeItems<T>(values: readonly T[], step: Step, report?: StorageReporter): Generator<T> {
  if (!report || !values.length) {
    yield* values
    return
  }
  const total = values.length
  let completed = 0
  let lastReport = Date.now()
  reportUpgradeStep(report, step, { completed, total })
  for (const value of values) {
    yield value
    completed++
    if (completed === total || Date.now() - lastReport >= 100) {
      reportUpgradeStep(report, step, { completed, total })
      lastReport = Date.now()
    }
  }
}
