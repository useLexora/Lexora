import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { writePrivateServiceJson } from './serviceFiles'

const fileNames = { launcher: 'foreground-launch.json', core: 'core-host-startup.json' } as const
const stageSchema = z.enum(['connect', 'storage', 'service_start', 'open_desktop', 'core_management', 'host_spawn', 'host_bootstrap', 'host_handshake'])
const outcomeSchema = z.enum(['pending', 'ready', 'maintenance', 'failed', 'cancelled', 'timeout', 'channel_closed', 'remote_error', 'request_failed', 'invalid_reply', 'locked', 'refused', 'hidden', 'ui_not_ready', 'target_not_visible', 'visible'])
const pid = z.number().int().positive().max(0xFFFFFFFF)
const recordSchema = z.object({
  version: z.literal(1),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime(),
  occurredAt: z.iso.datetime(),
  pid,
  corePid: pid.optional(),
  hostPid: pid.optional(),
  stage: stageSchema,
  outcome: outcomeSchema,
}).strict()

export function createPrivateStartupRecord(directory: string, source: keyof typeof fileNames, buildId: string) {
  const startedAt = new Date().toISOString()
  let pending = Promise.resolve()
  let latest = 0
  return (stage: z.infer<typeof stageSchema>, outcome: z.infer<typeof outcomeSchema>, processes: { corePid?: number, hostPid?: number } = {}) => {
    const occurredAt = new Date().toISOString()
    const revision = ++latest
    pending = pending.then(async () => {
      if (revision !== latest || !isAbsolute(directory))
        return
      const record = recordSchema.parse({ version: 1, buildId, startedAt, occurredAt, pid: process.pid, ...processes, stage, outcome })
      const stat = await lstat(directory)
      if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)))
        return
      await writePrivateServiceJson(join(directory, fileNames[source]), record)
    }).catch(() => {})
    return pending
  }
}
