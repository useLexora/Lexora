import type { ProcessMetric } from 'electron'
import { describe, it } from 'vitest'
import { DesktopPerformanceMonitor } from '../DesktopPerformanceMonitor'

const metrics: ProcessMetric[] = Array.from({ length: 32 }, (_, pid) => ({ pid, creationTime: 1, type: 'Utility', name: 'Buddy Local Service', cpu: { cumulativeCPUUsage: 0, percentCPUUsage: 0, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 } }))
const read = () => ({ metrics, proxy: { accepted: 100, reportedFailures: 0, opened: 100, closed: 100, active: 0 } })
const monitor = new DesktopPerformanceMonitor(read, () => {})

describe('diagnostic bookkeeping at the 32-process bound (excludes OS reads)', () => {
  it('disabled', async ({ bench }) => {
    await bench('disabled', () => read()).run({ time: 300 })
  })
  it('enabled', async ({ bench }) => {
    await bench('enabled', () => monitor.sample()).run({ time: 1000 })
  })
})
