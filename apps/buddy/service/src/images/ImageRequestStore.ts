import type { ImageTarget } from '../../../shared/images/imagePreferences'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { syncStorageDirectory } from '../../../platform/storage/storageFiles'
import { imageTargetSchema } from '../../../shared/images/imagePreferences'
import { ImageGenerationError } from './ImageGenerationGateway'

const receiptSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  toolCallId: z.string(),
  state: z.enum(['unknown', 'completed', 'failed', 'partial']),
  attempts: z.array(z.object({ target: imageTargetSchema, attempt: z.number().int(), backendRequestId: z.string().optional() })),
  artifactIds: z.array(z.string()),
  responseId: z.string().nullable(),
})
type Receipt = z.infer<typeof receiptSchema>
export interface ImageRequestReceipt {
  id: string
  attempt: (target: ImageTarget, attempt: number, backendRequestId?: string) => Promise<void>
  settle: (state: Receipt['state'], artifactIds?: string[], responseId?: string | null) => Promise<void>
}

export class ImageRequestStore {
  #pending: Promise<unknown> = Promise.resolve()
  readonly #active = new Set<string>()
  readonly paths: BuddyDataPaths
  constructor(paths: BuddyDataPaths) { this.paths = paths }

  begin(conversationId: string, runId: string, toolCallId: string): Promise<ImageRequestReceipt> {
    const result = this.#pending.then(() => this.#begin(conversationId, runId, toolCallId))
    this.#pending = result.catch(() => {})
    return result
  }

  async #begin(conversationId: string, runId: string, toolCallId: string): Promise<ImageRequestReceipt> {
    z.uuid().parse(runId)
    const directory = join(this.paths.conversationDirectory(conversationId), 'image-requests', runId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json'))
        continue
      const previous = receiptSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))
      if (previous.toolCallId === toolCallId || ((!this.#active.has(previous.id)) && ['unknown', 'partial'].includes(previous.state)))
        throw new ImageGenerationError('IMAGE_GENERATION_INCOMPLETE', { diagnostic: { requestId: previous.id } })
    }
    const value: Receipt = { id: randomUUID(), runId, toolCallId, state: 'unknown', attempts: [], artifactIds: [], responseId: null }
    const save = async () => {
      const temporary = join(directory, `${value.id}.${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(value))
          await handle.sync()
        }
        finally { await handle.close() }
        await rename(temporary, join(directory, `${value.id}.json`))
        await syncStorageDirectory(directory)
      }
      finally { await rm(temporary, { force: true }) }
    }
    this.#active.add(value.id)
    try {
      await save()
    }
    catch (error) {
      this.#active.delete(value.id)
      throw error
    }
    return {
      id: value.id,
      attempt: async (target, attempt, backendRequestId) => {
        const last = value.attempts.at(-1)
        if (last?.attempt === attempt)
          last.backendRequestId = backendRequestId
        else
          value.attempts.push({ target, attempt, ...(backendRequestId ? { backendRequestId } : {}) })
        await save()
      },
      settle: async (state, artifactIds, responseId) => {
        value.state = state
        if (artifactIds)
          value.artifactIds = artifactIds
        if (responseId !== undefined)
          value.responseId = responseId
        try {
          await save()
        }
        finally { this.#active.delete(value.id) }
      },
    }
  }
}
