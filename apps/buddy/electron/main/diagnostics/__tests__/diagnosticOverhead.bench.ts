import type { ProcessMetric } from 'electron'
import { bench, describe } from 'vitest'
import { DesktopPerformanceMonitor } from '../DesktopPerformanceMonitor'

const metrics: ProcessMetric[] = Array.from({ length: 32 }, (_, pid) => ({ pid, creationTime: 1, type: 'Utility', name: 'Buddy Local Service', cpu: { cumulativeCPUUsage: 0, percentCPUUsage: 0, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 } }))
const read = () => ({ metrics, proxy: { accepted: 100, reportedFailures: 0, opened: 100, closed: 100, active: 0 } })
const monitor = new DesktopPerformanceMonitor(read, () => {})

describe('diagnostic bookkeeping at the 32-process bound (excludes OS reads)', () => {
  bench('disabled', () => {
    read()
  }, { time: 300 })
  bench('enabled', () => monitor.sample(), { time: 1000 })
})
