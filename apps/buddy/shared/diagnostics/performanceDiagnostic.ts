import { z } from 'zod'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const measurement = z.number().finite().nonnegative()
export const processRoleSchema = z.enum(['main', 'runtime', 'renderer', 'gpu', 'network', 'sandbox', 'utility', 'other'])
export const performanceSampleSchema = z.object({
  sampledAt: z.iso.datetime(),
  elapsedMs: measurement,
  collectionMs: measurement,
  intervalMs: measurement,
  logicalCpuCount: count,
  truncated: z.boolean(),
  processes: z.array(z.object({
    pid: count,
    createdAt: measurement,
    role: processRoleSchema,
    cpuPercent: measurement.nullable().describe('Percentage of total logical CPU capacity; null when the interval or processor count is unavailable'),
    memoryKiB: count,
  }).strict()).max(32),
  proxy: z.object({ accepted: count, reportedFailures: count, opened: count, closed: count, active: count }).strict(),
}).strict()

export type PerformanceSample = z.infer<typeof performanceSampleSchema>
export type ProcessRole = z.infer<typeof processRoleSchema>

export const cpuProfileTargetSchema = z.enum(['main', 'runtime', 'renderer'])
export type CpuProfileTarget = z.infer<typeof cpuProfileTargetSchema>
export const cpuProfileRequestSchema = z.object({ target: cpuProfileTargetSchema, pid: count }).strict()
export type CpuProfileRequest = z.infer<typeof cpuProfileRequestSchema>
export const cpuProfileSummarySchema = z.object({
  target: cpuProfileTargetSchema,
  pid: count,
  durationMs: measurement,
  samples: count,
  hotspots: z.array(z.object({
    location: z.string().regex(/^(?:main|runtime|renderer|dependency|external|idle|gc|native|root)(?::[a-f0-9]{12}:\d+:\d+)?$/),
    selfMs: measurement,
  }).strict()).max(20),
}).strict()
export type CpuProfileSummary = z.infer<typeof cpuProfileSummarySchema>

export interface PerformanceDiagnosticApi {
  snapshot: () => Promise<{ samples: PerformanceSample[], coverage: 'electron-processes', intervalMs: number, rendererPid: number }>
  capture: (request: CpuProfileRequest) => Promise<CpuProfileSummary>
}
