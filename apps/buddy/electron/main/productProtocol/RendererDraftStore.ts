import type { DraftRecoveryOwner, DraftRecoveryRecord } from '../../../shared/conversation/draftRecovery'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { isMissing, readStorageJson, writeStorageJson } from '../../../platform/storage/storageFiles'
import { draftRecoveryOwnerSchema, draftRecoveryRecordSchema } from '../../../shared/conversation/draftRecovery'

const entrySchema = z.object({ owner: draftRecoveryOwnerSchema, sequence: z.number().int().nonnegative(), editorSessionId: z.uuid(), record: draftRecoveryRecordSchema.nullable() }).strict()
const maxBytes = 8 * 1024 * 1024

export class RendererDraftStore {
  readonly #directory: string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(directory: string) {
    this.#directory = directory
  }

  load(): Promise<DraftRecoveryRecord[]> {
    return this.#serial(async () => {
      const files = await readdir(this.#directory).catch((error: unknown) => {
        if (isMissing(error))
          return []
        throw error
      })
      const records: DraftRecoveryRecord[] = []
      for (const name of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(name))
          continue
        const entry = entrySchema.parse(await readStorageJson(join(this.#directory, name), maxBytes))
        if (name !== this.#name(entry.owner, entry.editorSessionId))
          throw new Error('DRAFT_RECOVERY_CORRUPTED')
        if (entry.record) {
          if (!isDeepStrictEqual(entry.record.owner, entry.owner) || entry.record.sequence !== entry.sequence || entry.record.snapshot.editorSessionId !== entry.editorSessionId)
            throw new Error('DRAFT_RECOVERY_CORRUPTED')
          records.push(entry.record)
        }
      }
      if (records.length > 1000)
        throw new Error('DRAFT_RECOVERY_LIMIT')
      return records
    })
  }

  write(raw: DraftRecoveryRecord): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(raw)) > maxBytes)
      return Promise.reject(new Error('DRAFT_RECOVERY_LIMIT'))
    const record = draftRecoveryRecordSchema.parse(raw)
    return this.#write({ owner: record.owner, sequence: record.sequence, editorSessionId: record.snapshot.editorSessionId, record })
  }

  remove(owner: DraftRecoveryOwner, editorSessionId: string, sequence: number): Promise<void> {
    return this.#write({ owner, editorSessionId, sequence, record: null })
  }

  #write(value: z.infer<typeof entrySchema>): Promise<void> {
    const entry = entrySchema.parse(value)
    return this.#serial(async () => {
      const path = join(this.#directory, this.#name(entry.owner, entry.editorSessionId))
      const previous = await readStorageJson(path, maxBytes).then(value => value === null ? null : entrySchema.parse(value)).catch((error: unknown) => {
        if (isMissing(error))
          return null
        throw error
      })
      if (previous && (!isDeepStrictEqual(previous.owner, entry.owner) || previous.editorSessionId !== entry.editorSessionId))
        throw new Error('DRAFT_RECOVERY_CORRUPTED')
      if (previous && (previous.sequence > entry.sequence || (previous.sequence === entry.sequence && !isDeepStrictEqual(previous, entry))))
        throw new Error('DRAFT_RECOVERY_STALE_WRITE')
      if (!previous || previous.sequence !== entry.sequence)
        await writeStorageJson(path, entry)
    })
  }

  #name(owner: DraftRecoveryOwner, editorSessionId: string): string {
    return `${createHash('sha256').update(JSON.stringify([owner.serviceId, owner.profileId, owner.dataGeneration, owner.deviceId, editorSessionId])).digest('hex')}.json`
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.catch(() => {}).then(operation)
    this.#tail = pending
    return pending
  }
}
