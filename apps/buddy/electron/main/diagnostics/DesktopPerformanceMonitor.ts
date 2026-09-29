import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { PerformanceSample, ProcessRole } from '../../../shared/diagnostics/performanceDiagnostic'
import { cpus } from 'node:os'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { performanceSampleSchema } from '../../../shared/diagnostics/performanceDiagnostic'

export const PERFORMANCE_INTERVAL_MS = 5000
const HISTORY_LIMIT = 60

export class DesktopPerformanceMonitor {
  readonly #read: () => { metrics: Electron.ProcessMetric[], proxy: PerformanceSample['proxy'] }
  readonly #record: ApplicationDiagnosticReporter
  readonly #logicalCpuCount: number
  readonly #startedAt = performance.now()
  #timer: ReturnType<typeof setInterval> | undefined
  #history: PerformanceSample[] = []
  #previous = new Map<string, { cpu?: number, highSince?: number }>()
  #lastAt = 0
  #nextIncidentAt = 0
  #incident: { id: string, remaining: number } | undefined

  constructor(read: () => { metrics: Electron.ProcessMetric[], proxy: PerformanceSample['proxy'] }, record: ApplicationDiagnosticReporter, logicalCpuCount = cpus().length) {
    this.#read = read
    this.#record = safeDiagnosticReporter(record)
    this.#logicalCpuCount = logicalCpuCount
  }

  start(): void {
    if (this.#timer)
      return
    this.sample()
    this.#timer = setInterval(() => this.sample(), PERFORMANCE_INTERVAL_MS)
    this.#timer.unref()
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#previous.clear()
    this.#history = []
    this.#incident = undefined
  }

  snapshot() {
    return { samples: structuredClone(this.#history), coverage: 'electron-processes' as const, intervalMs: PERFORMANCE_INTERVAL_MS }
  }

  sample(): void {
    const now = performance.now()
    try {
      const { metrics, proxy } = this.#read()
      const intervalMs = this.#previous.size ? now - this.#lastAt : 0
      const previous = this.#previous
      const next = new Map<string, { cpu?: number, highSince?: number }>()
      let sustained = false
      const processes = metrics.slice(0, 32).map((metric) => {
        const key = `${metric.pid}:${metric.creationTime}`
        const before = previous.get(key)
        const cpu = metric.cpu.cumulativeCPUUsage
        const occupiedCores = before?.cpu !== undefined && cpu !== undefined && cpu >= before.cpu && intervalMs > 0
          ? (cpu - before.cpu) * 1000 / intervalMs
          : null
        const cpuPercent = occupiedCores !== null && this.#logicalCpuCount > 0 ? occupiedCores * 100 / this.#logicalCpuCount : null
        const highSince = occupiedCores !== null && occupiedCores >= 0.5 && intervalMs <= PERFORMANCE_INTERVAL_MS * 3 ? before?.highSince ?? now : undefined
        if (highSince !== undefined && now - highSince >= 30_000)
          sustained = true
        next.set(key, { cpu, highSince })
        return { pid: metric.pid, createdAt: metric.creationTime, role: processRole(metric), cpuPercent, memoryKiB: metric.memory.workingSetSize }
      })
      const sample = performanceSampleSchema.parse({ sampledAt: new Date().toISOString(), elapsedMs: now - this.#startedAt, intervalMs, collectionMs: performance.now() - now, logicalCpuCount: this.#logicalCpuCount, processes, proxy, truncated: metrics.length > 32 })
      this.#lastAt = now
      this.#previous = next
      this.#history.push(sample)
      if (this.#history.length > HISTORY_LIMIT)
        this.#history.shift()
      if (sustained && now >= this.#nextIncidentAt && !this.#incident) {
        this.#incident = { id: crypto.randomUUID(), remaining: 6 }
        this.#nextIncidentAt = now + 300_000
        this.#record({ event: 'performance.sustained_cpu', component: 'desktop.performance', level: 'warn', operationId: this.#incident.id })
        for (const frame of this.#history)
          this.#recordSample(frame, this.#incident.id)
      }
      else if (this.#incident) {
        this.#recordSample(sample, this.#incident.id)
        if (--this.#incident.remaining === 0)
          this.#incident = undefined
      }
    }
    catch {
      this.#previous.clear()
      if (now >= this.#nextIncidentAt) {
        this.#nextIncidentAt = now + 300_000
        this.#record({ event: 'performance.sample_failed', level: 'warn', errorCode: 'PERFORMANCE_SAMPLE_FAILED' })
      }
    }
  }

  #recordSample(performanceSample: PerformanceSample, operationId: string): void {
    this.#record({ event: 'performance.sample', component: 'desktop.performance', level: 'info', operationId, performanceSample })
  }
}

function processRole(metric: Electron.ProcessMetric): ProcessRole {
  if (metric.type === 'Browser')
    return 'main'
  if (metric.type === 'Tab')
    return 'renderer'
  if (metric.type === 'GPU')
    return 'gpu'
  if (metric.name === 'Buddy Local Service')
    return 'runtime'
  if (metric.name === 'Buddy Shell Sandbox')
    return 'sandbox'
  if (metric.serviceName === 'network.mojom.NetworkService')
    return 'network'
  return metric.type === 'Utility' ? 'utility' : 'other'
}
