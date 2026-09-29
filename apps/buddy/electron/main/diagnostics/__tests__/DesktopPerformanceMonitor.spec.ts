import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopPerformanceMonitor } from '../DesktopPerformanceMonitor'

afterEach(() => vi.useRealTimers())
const proxy = { accepted: 1, reportedFailures: 0, opened: 1, closed: 1, active: 0 }
function metric(cpu = 0, creationTime = 1): Electron.ProcessMetric {
  return { pid: 42, creationTime, type: 'Utility', name: 'Buddy Local Service', cpu: { percentCPUUsage: 999, cumulativeCPUUsage: cpu, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 } }
}

describe('performance evidence', () => {
  it.each([1, 8, 32])('normalizes interval CPU deltas across %i logical processors and resets reused PIDs', (logicalCpuCount) => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] })
    let current = metric()
    const records: ApplicationDiagnostic[] = []
    const monitor = new DesktopPerformanceMonitor(() => ({ metrics: [current], proxy }), event => records.push(event), logicalCpuCount)
    monitor.start()
    expect(monitor.snapshot().samples[0]?.processes[0]?.cpuPercent).toBeNull()
    current = metric(2.5)
    vi.advanceTimersByTime(5000)
    expect(monitor.snapshot().samples.at(-1)?.logicalCpuCount).toBe(logicalCpuCount)
    expect(monitor.snapshot().samples.at(-1)?.processes[0]).toMatchObject({ cpuPercent: 50 / logicalCpuCount, role: 'runtime', pid: 42 })
    current = metric(0, 2)
    vi.advanceTimersByTime(5000)
    expect(monitor.snapshot().samples.at(-1)?.processes[0]?.cpuPercent).toBeNull()
    current = { ...current, cpu: { percentCPUUsage: 999, idleWakeupsPerSecond: 0 } }
    vi.advanceTimersByTime(5000)
    expect(monitor.snapshot().samples.at(-1)?.processes[0]?.cpuPercent).toBeNull()
    expect(records).toEqual([])
    monitor.stop()
    vi.advanceTimersByTime(10000)
    expect(monitor.snapshot().samples).toEqual([])
  })

  it('retains bounded history and before/after evidence without logging each routine sample', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] })
    const records: ApplicationDiagnostic[] = []
    const monitor = new DesktopPerformanceMonitor(() => ({ metrics: [metric(performance.now() / 1000)], proxy }), event => records.push(event), 32)
    monitor.start()
    vi.advanceTimersByTime(30000)
    expect(records).toEqual([])
    vi.advanceTimersByTime(5000)
    expect(records[0]?.event).toBe('performance.sustained_cpu')
    expect(monitor.snapshot().samples.at(-1)?.processes[0]?.cpuPercent).toBe(3.125)
    expect(records.filter(record => record.performanceSample)).toHaveLength(8)
    vi.advanceTimersByTime(30000)
    expect(records.filter(record => record.performanceSample)).toHaveLength(14)
    vi.advanceTimersByTime(240000)
    expect(monitor.snapshot().samples).toHaveLength(60)
    expect(records.filter(record => record.event === 'performance.sustained_cpu')).toHaveLength(1)
    monitor.stop()
  })

  it('bounds process cardinality, excludes names and isolates sampler/observer failures', () => {
    const monitor = new DesktopPerformanceMonitor(() => ({ metrics: Array.from({ length: 80 }, (_, pid) => ({ ...metric(), pid, name: 'private-hostname' })), proxy }), () => {
      throw new Error('observer')
    })
    monitor.sample()
    const snapshot = monitor.snapshot()
    expect(snapshot.samples[0]?.truncated).toBe(true)
    expect(snapshot.samples[0]?.processes).toHaveLength(32)
    expect(JSON.stringify(snapshot)).not.toContain('private-hostname')
    snapshot.samples.splice(0)
    expect(monitor.snapshot().samples).toHaveLength(1)
    const broken = new DesktopPerformanceMonitor(() => {
      throw new Error('private path')
    }, () => {
      throw new Error('observer')
    })
    expect(() => broken.sample()).not.toThrow()
  })
})
