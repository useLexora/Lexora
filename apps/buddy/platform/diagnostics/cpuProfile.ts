import type { Profiler } from 'node:inspector'
import type { CpuProfileSummary, CpuProfileTarget } from '../../shared/diagnostics/performanceDiagnostic'
import { createHash } from 'node:crypto'
import { Session } from 'node:inspector/promises'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { cpuProfileSummarySchema } from '../../shared/diagnostics/performanceDiagnostic'

export interface CpuProfilerConnection {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  close: () => void
}

export async function captureCpuProfile(connection: CpuProfilerConnection, target: CpuProfileTarget, pid: number, trustedCode: (url: string) => string | null, signal?: AbortSignal): Promise<CpuProfileSummary> {
  try {
    signal?.throwIfAborted()
    await connection.send('Profiler.enable')
    await connection.send('Profiler.setSamplingInterval', { interval: 10_000 })
    signal?.throwIfAborted()
    await connection.send('Profiler.start')
    await setTimeout(5000, undefined, { signal })
    const { profile } = await connection.send('Profiler.stop') as { profile: Profiler.Profile }
    return summarizeCpuProfile(profile, target, pid, trustedCode)
  }
  finally {
    connection.close()
  }
}

export async function captureNodeCpuProfile(target: 'main' | 'runtime', signal?: AbortSignal): Promise<CpuProfileSummary> {
  const session = new Session()
  session.connect()
  const root = new URL(import.meta.url.includes('/chunks/') ? '../' : '.', import.meta.url).href
  return captureCpuProfile({ send: (method, params) => session.post(method, params), close: () => session.disconnect() }, target, process.pid, (url) => {
    if (!url.startsWith(root))
      return null
    const relative = url.slice(root.length)
    return /^(?:chunks\/)?[\w-]+\.js$/.test(relative) ? relative : null
  }, signal)
}

export function summarizeCpuProfile(profile: Profiler.Profile, target: CpuProfileTarget, pid: number, trustedCode: (url: string) => string | null): CpuProfileSummary {
  if (profile.nodes.length > 50_000 || (profile.samples?.length ?? 0) > 20_000 || !profile.samples || !profile.timeDeltas || profile.samples.length !== profile.timeDeltas.length)
    throw new Error('CPU_PROFILE_LIMIT')
  const locations = new Map<number, string>()
  for (const node of profile.nodes) {
    const frame = node.callFrame
    const code = trustedCode(frame.url)
    const builtin = new Map([['(idle)', 'idle'], ['(garbage collector)', 'gc'], ['(program)', 'native'], ['(root)', 'root']])
    const location = code
      ? `${target}:${createHash('sha256').update(code).digest('hex').slice(0, 12)}:${Math.max(0, frame.lineNumber + 1)}:${Math.max(0, frame.columnNumber + 1)}`
      : frame.url ? 'external' : builtin.get(frame.functionName) ?? 'native'
    locations.set(node.id, location)
  }
  const totals = new Map<string, number>()
  for (let index = 0; index < profile.samples.length; index++) {
    const location = locations.get(profile.samples[index]!) ?? 'external'
    const milliseconds = profile.timeDeltas[index]! / 1000
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error('CPU_PROFILE_INVALID')
    totals.set(location, (totals.get(location) ?? 0) + milliseconds)
  }
  return cpuProfileSummarySchema.parse({ target, pid, durationMs: (profile.endTime - profile.startTime) / 1000, samples: profile.samples.length, hotspots: [...totals].map(([location, selfMs]) => ({ location, selfMs })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 20) })
}
