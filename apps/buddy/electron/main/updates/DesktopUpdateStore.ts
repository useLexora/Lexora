import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { desktopUpdateResultSchema, desktopVersionSchema } from '../../shared/desktopUpdates'

const timestamp = z.number().int().nonnegative().nullable()
const version = desktopVersionSchema.nullable()
const updateRecordSchema = z.object({
  version: z.literal(1),
  lastCheckedAt: timestamp,
  lastNotifiedAt: timestamp,
  notifiedVersion: version,
  ignoredVersion: version,
  seenVersion: version,
  discoveredAt: timestamp,
  result: desktopUpdateResultSchema.nullable(),
}).strict()

export type DesktopUpdateRecord = z.infer<typeof updateRecordSchema>

export function emptyUpdateRecord(): DesktopUpdateRecord {
  return { version: 1, lastCheckedAt: null, lastNotifiedAt: null, notifiedVersion: null, ignoredVersion: null, seenVersion: null, discoveredAt: null, result: null }
}

export class DesktopUpdateStore {
  readonly #directory: string

  constructor(directory: string) {
    this.#directory = directory
  }

  async read(): Promise<DesktopUpdateRecord> {
    const path = join(this.#directory, 'updates.json')
    try {
      if ((await stat(path)).size > 8 * 1024 * 1024)
        throw new Error('UPDATE_STATE_TOO_LARGE')
      return updateRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyUpdateRecord()
      throw new Error('UPDATE_STATE_UNAVAILABLE', { cause: error })
    }
  }

  async write(record: DesktopUpdateRecord): Promise<void> {
    const data = JSON.stringify(updateRecordSchema.parse(record))
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.#directory, `updates-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(data)
        await file.sync()
      }
      finally {
        await file.close()
      }
      await fileStorage.replace(temporary, join(this.#directory, 'updates.json'))
    }
    finally {
      await rm(temporary, { force: true })
    }
  }
}
