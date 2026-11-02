import type { ApplicationStartupState } from '@buddy-shared/diagnostics/applicationStartup'
import { describe, expect, it } from 'vitest'
import { startupPresentation } from '../startupPresentation'

type Stage = ApplicationStartupState['stages'][number]

describe('startup presentation', () => {
  it('shows the active initialization stage instead of the running connection parent', () => {
    expect(startupPresentation([
      { stage: 'runtime.connection', status: 'running' },
      { stage: 'runtime.database', status: 'running' },
    ])).toEqual({ label: 'desktop.loading.database', progress: null })
  })

  it('uses a running leaf rather than its parent or completed stages', () => {
    expect(startupPresentation([
      { stage: 'runtime.event_replay', status: 'completed', progress: { completed: 50, total: 50 } },
      { stage: 'renderer', status: 'running', progress: { completed: 1, total: 2 } },
      { stage: 'renderer.tasks', status: 'running', progress: { completed: 5, total: 20 } },
    ])).toEqual({ label: 'desktop.loading.workspace', progress: 0.25 })
  })

  it('only derives progress from the active stage', () => {
    const stages: Stage[] = [
      { stage: 'desktop', status: 'completed' },
      { stage: 'runtime.connection', status: 'running' },
      { stage: 'runtime.database', status: 'completed' },
      { stage: 'runtime.event_replay', status: 'running', progress: { completed: 30, total: 100 } },
    ]
    expect(startupPresentation(stages)).toEqual({ label: 'desktop.loading.history', progress: 0.3 })
    expect(startupPresentation(stages.map(stage => ({ ...stage, progress: undefined })))).toEqual({ label: 'desktop.loading.history', progress: null })
  })

  it.each([
    [0, 0],
    [100, 1],
  ])('shows completed %s at the stage boundary', (completed, expected) => {
    expect(startupPresentation([{ stage: 'runtime.event_replay', status: 'running', progress: { completed, total: 100 } }]).progress).toBe(expected)
  })

  it('never carries running progress into failure', () => {
    const running: Stage = { stage: 'runtime.event_replay', status: 'running', progress: { completed: 20, total: 100 } }
    expect(startupPresentation([running], true)).toEqual({ label: 'desktop.loading.failed', progress: null })
    expect(startupPresentation([running, { stage: 'renderer', status: 'failed' }])).toEqual({ label: 'desktop.loading.failed', progress: null })
  })

  it('keeps initial and empty-work progress indeterminate', () => {
    expect(startupPresentation([])).toEqual({ label: 'desktop.loading.app', progress: null })
    expect(startupPresentation([{ stage: 'runtime.event_replay', status: 'running', progress: { completed: 0, total: 0 } }]))
      .toEqual({ label: 'desktop.loading.history', progress: null })
  })
})
