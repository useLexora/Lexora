import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readStorageJson, writeStorageJson } from '../storage/storageFiles'
import { extensionScheduleStateSchema, storedIndexSchema } from './extensionState'

export async function restoreExtensionBackup(incoming: string, candidate: string): Promise<void> {
  const imported = await readStorageJson(join(incoming, 'installed.json'))
  if (imported) {
    const restored = storedIndexSchema.parse(imported)
    const saved = await readStorageJson(join(candidate, 'installed.json'))
    const current = saved ? storedIndexSchema.parse(saved) : null
    for (const [id, record] of Object.entries(restored.installed)) {
      record.enabled = false
      record.pending = null
      await rm(join(candidate, 'data', id, 'resources'), { recursive: true, force: true })
      for (const file of ['local-resources.json', 'local-directories.json', 'state.previous.json'])
        await rm(join(candidate, 'data', id, file), { force: true })
    }
    await writeStorageJson(join(candidate, 'installed.json'), { version: 1, installed: { ...current?.installed, ...restored.installed } })
  }
  const importedSchedules = await readStorageJson(join(incoming, 'schedules.json'))
  if (importedSchedules) {
    const restored = extensionScheduleStateSchema.parse(importedSchedules)
    const saved = await readStorageJson(join(candidate, 'schedules.json'))
    const current = saved ? extensionScheduleStateSchema.parse(saved) : null
    const jobs = new Map((current?.jobs ?? []).map(job => [`${job.extensionId}/${job.id}`, job]))
    for (const job of restored.jobs)
      jobs.set(`${job.extensionId}/${job.id}`, { ...job, enabled: false, nextRunAt: null })
    await writeStorageJson(join(candidate, 'schedules.json'), extensionScheduleStateSchema.parse({ version: 1, jobs: [...jobs.values()] }))
  }
}
