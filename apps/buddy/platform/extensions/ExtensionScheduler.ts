import type { ExtensionSchedule, ExtensionScheduleInput } from '../../shared/extensions/extensionSchedule'
import { join } from 'node:path'
import { z } from 'zod'
import { extensionIdSchema } from '../../shared/extensions/extensionManifest'
import { extensionScheduleSchema } from '../../shared/extensions/extensionSchedule'
import { readExtensionJson, writeExtensionJson } from './extensionFiles'

const jobSchema = extensionScheduleSchema.extend({ extensionId: extensionIdSchema })
const stateSchema = z.object({ version: z.literal(1), jobs: z.array(jobSchema).max(512) }).strict()
type Job = z.infer<typeof jobSchema>
interface SchedulerPorts {
  available: (extensionId: string, command: string) => boolean
  execute: (extensionId: string, command: string) => Promise<unknown>
  failed: (extensionId: string, error: unknown) => void
  now?: () => number
}

export class ExtensionScheduler {
  readonly #path: string
  readonly #ports: SchedulerPorts
  readonly #now: () => number
  #jobs: Job[] = []
  #tail = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | undefined
  #suspended = false
  #disposed = false

  constructor(root: string, ports: SchedulerPorts) {
    this.#path = join(root, 'schedules.json')
    this.#ports = ports
    this.#now = ports.now ?? Date.now
  }

  async load(): Promise<void> {
    try {
      this.#jobs = stateSchema.parse(await readExtensionJson(this.#path)).jobs
      if (new Set(this.#jobs.map(job => `${job.extensionId}/${job.id}`)).size !== this.#jobs.length)
        throw new Error('Duplicate schedule')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('EXTENSION_SCHEDULES_UNREADABLE', { cause: error })
    }
    await this.resume()
  }

  get(extensionId: string, id: string): ExtensionSchedule | null {
    const job = this.#jobs.find(job => job.extensionId === extensionId && job.id === id)
    return job ? { id: job.id, command: job.command, enabled: job.enabled, intervalMinutes: job.intervalMinutes, nextRunAt: job.nextRunAt } : null
  }

  async set(extensionId: string, input: ExtensionScheduleInput, assertCurrent: () => void): Promise<ExtensionSchedule> {
    const job: Job = { ...input, extensionId, nextRunAt: input.enabled ? this.#now() + input.intervalMinutes * 60000 : null }
    await this.#update((jobs) => {
      const retained = jobs.filter(item => item.extensionId !== extensionId || item.id !== input.id)
      if (retained.filter(item => item.extensionId === extensionId).length >= 32 || retained.length >= 512)
        throw new Error('EXTENSION_SCHEDULE_LIMIT')
      return [...retained, job]
    }, assertCurrent)
    return this.get(extensionId, input.id)!
  }

  remove(extensionId: string, id?: string, assertCurrent: () => void = () => {}): Promise<void> {
    return this.#update(jobs => jobs.filter(job => job.extensionId !== extensionId || (id !== undefined && job.id !== id)), assertCurrent)
  }

  suspend(): void {
    this.#suspended = true
    clearTimeout(this.#timer)
  }

  async resume(): Promise<void> {
    this.#suspended = false
    const now = this.#now()
    await this.#update(jobs => jobs.map(job => job.enabled && job.nextRunAt !== null && job.nextRunAt <= now ? { ...job, nextRunAt: now + job.intervalMinutes * 60000 } : job))
  }

  refresh(): void {
    clearTimeout(this.#timer)
    if (this.#disposed || this.#suspended)
      return
    const next = this.#jobs.filter(job => job.enabled && job.nextRunAt !== null && this.#ports.available(job.extensionId, job.command)).reduce((next, job) => Math.min(next, job.nextRunAt!), Infinity)
    if (Number.isFinite(next)) {
      this.#timer = setTimeout(() => void this.#tick().catch(error => this.#ports.failed('', error)), Math.min(2147483647, Math.max(0, next - this.#now())))
      this.#timer.unref()
    }
  }

  dispose(): void {
    this.#disposed = true
    clearTimeout(this.#timer)
  }

  async #tick(): Promise<void> {
    const due: Job[] = []
    const now = this.#now()
    await this.#update(jobs => jobs.map((job) => {
      if (!job.enabled || job.nextRunAt === null || job.nextRunAt > now || !this.#ports.available(job.extensionId, job.command))
        return job
      const advanced = { ...job, nextRunAt: now + job.intervalMinutes * 60000 }
      if (now - job.nextRunAt < 60000)
        due.push(advanced)
      return advanced
    }))
    for (const job of due) {
      if (this.#disposed || this.#suspended || !this.#jobs.includes(job) || !this.#ports.available(job.extensionId, job.command))
        continue
      try {
        await this.#ports.execute(job.extensionId, job.command)
      }
      catch (error) {
        this.#ports.failed(job.extensionId, error)
      }
    }
  }

  #update(change: (jobs: Job[]) => Job[], assertCurrent: () => void = () => {}): Promise<void> {
    const operation = this.#tail.catch(() => {}).then(async () => {
      if (this.#disposed)
        throw new Error('EXTENSION_HOST_STOPPED')
      assertCurrent()
      const next = change(this.#jobs)
      await writeExtensionJson(this.#path, { version: 1, jobs: next }, () => {
        if (this.#disposed)
          throw new Error('EXTENSION_HOST_STOPPED')
        assertCurrent()
      })
      this.#jobs = next
      this.refresh()
    })
    this.#tail = operation
    return operation
  }
}
