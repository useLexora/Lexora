import type { ImageGenerationFailure, ImageGenerationRetainedOutput, ImageRequestRef } from '../../../shared/images/imageGeneration'
import type { ImageTarget } from '../../../shared/images/imagePreferences'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { syncStorageDirectory } from '../../../platform/storage/storageFiles'
import { imageGenerationFailureSchema, imageGenerationRetainedOutputSchema } from '../../../shared/images/imageGeneration'
import { imageSourceSchema, imageTargetSchema } from '../../../shared/images/imagePreferences'
import { ImageGenerationError } from './ImageGenerationGateway'

const resultSchema = z.object({
  artifactIds: z.array(z.string()),
  outputs: z.array(z.object({ artifactId: z.string(), path: z.string(), mimeType: z.string() })),
  responseId: z.string().nullable(),
  source: imageSourceSchema.optional(),
})
export type ImageRequestResult = z.infer<typeof resultSchema>
const identitySchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), destination: z.string().regex(/^[a-f0-9]{64}$/) })
export type ImageRequestIdentity = z.infer<typeof identitySchema>
const referenceSchema = z.object({ referenceId: z.string().min(1), mimeType: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export type ImageRequestReference = z.infer<typeof referenceSchema>
const receiptSchema = z.object({
  version: z.literal(2).optional(),
  id: z.uuid(),
  runId: z.uuid(),
  toolCallId: z.string(),
  identity: identitySchema.optional(),
  references: z.array(referenceSchema).optional(),
  state: z.enum(['preparing', 'unknown', 'completed', 'failed', 'partial']),
  attempts: z.array(z.object({ target: imageTargetSchema, attempt: z.number().int(), backendRequestId: z.string().optional() })),
  artifactIds: z.array(z.string()),
  responseId: z.string().nullable(),
  result: resultSchema.optional(),
  failure: imageGenerationFailureSchema.optional(),
  retainedOutputs: z.array(imageGenerationRetainedOutputSchema).optional(),
})
type Receipt = z.infer<typeof receiptSchema>
export interface ImageRequestReceipt {
  request: ImageRequestRef
  submitted: boolean
  attempt: (target: ImageTarget, attempt: number, backendRequestId?: string) => Promise<void>
  submitting: () => Promise<void>
  retain: (outputs: readonly ImageGenerationRetainedOutput[]) => Promise<void>
  complete: (result: ImageRequestResult) => Promise<void>
  fail: (failure: ImageGenerationFailure, artifactIds?: readonly string[]) => Promise<void>
}

export class ImageRequestStore {
  #pending: Promise<unknown> = Promise.resolve()
  readonly #active = new Set<string>()
  readonly paths: BuddyDataPaths
  constructor(paths: BuddyDataPaths) { this.paths = paths }

  begin(conversationId: string, runId: string, toolCallId: string, identity: ImageRequestIdentity, references?: readonly ImageRequestReference[]): Promise<{ kind: 'started', receipt: ImageRequestReceipt } | { kind: 'completed', result: ImageRequestResult, request: ImageRequestRef }> {
    return this.#serialize(async () => {
      z.uuid().parse(runId)
      identitySchema.parse(identity)
      const inputs = references ? z.array(referenceSchema).parse(references) : undefined
      const previous = await this.#readRun(conversationId, runId)
      const sameInvocation = previous.find(value => value.toolCallId === toolCallId)
      if (sameInvocation) {
        const request = this.#reference(conversationId, sameInvocation)
        if (sameInvocation.identity && (sameInvocation.identity.fingerprint !== identity.fingerprint || sameInvocation.identity.destination !== identity.destination))
          throw new ImageGenerationError('IMAGE_GENERATION_FAILED', { outcome: 'failed', diagnostic: { stage: 'preparing', localRequestId: sameInvocation.id }, request, retainedOutputs: sameInvocation.retainedOutputs })
        if (sameInvocation.state === 'completed')
          return { kind: 'completed' as const, request, result: sameInvocation.result ?? { artifactIds: sameInvocation.artifactIds, outputs: [], responseId: sameInvocation.responseId } }
        if (sameInvocation.state === 'failed') {
          const failure = sameInvocation.failure
          throw new ImageGenerationError(failure?.code === 'VALIDATION_FAILED' ? 'IMAGE_GENERATION_FAILED' : failure?.code ?? 'IMAGE_GENERATION_FAILED', { outcome: 'failed', diagnostic: failure?.diagnostic ?? { stage: 'preparing', localRequestId: sameInvocation.id }, request, retainedOutputs: sameInvocation.retainedOutputs })
        }
        if (sameInvocation.state !== 'preparing' || this.#active.has(sameInvocation.id))
          this.#block(conversationId, sameInvocation)
      }
      const unresolved = previous.find((value) => {
        if (!['preparing', 'unknown', 'partial'].includes(value.state))
          return false
        if (value.state === 'preparing' && !this.#active.has(value.id))
          return false
        return !value.identity || value.identity.fingerprint === identity.fingerprint || value.identity.destination === identity.destination
      })
      if (unresolved)
        this.#block(conversationId, unresolved)
      if (sameInvocation) {
        if (inputs) {
          sameInvocation.references = inputs
          await this.#save(conversationId, sameInvocation)
        }
        return { kind: 'started' as const, receipt: this.#activate(conversationId, sameInvocation) }
      }
      const value: Receipt = { version: 2, id: randomUUID(), runId, toolCallId, identity, ...(inputs ? { references: inputs } : {}), state: 'preparing', attempts: [], artifactIds: [], responseId: null }
      await this.#save(conversationId, value)
      return { kind: 'started' as const, receipt: this.#activate(conversationId, value) }
    })
  }

  completed(conversationId: string, runId: string, toolCallId: string): Promise<{ result: ImageRequestResult, request: ImageRequestRef } | null> {
    return this.#serialize(async () => {
      const value = (await this.#readRun(conversationId, runId)).find(value => value.toolCallId === toolCallId && value.state === 'completed')
      return value ? { request: this.#reference(conversationId, value), result: value.result ?? { artifactIds: value.artifactIds, outputs: [], responseId: value.responseId } } : null
    })
  }

  #activate(conversationId: string, value: Receipt): ImageRequestReceipt {
    this.#active.add(value.id)
    const update = (operation: () => Promise<void>, settle = false) => this.#serialize(async () => {
      try {
        await operation()
      }
      finally {
        if (settle)
          this.#active.delete(value.id)
      }
    })
    const receipt: ImageRequestReceipt = {
      request: this.#reference(conversationId, value),
      submitted: value.state !== 'preparing',
      attempt: (target, attempt, backendRequestId) => update(async () => {
        const last = value.attempts.at(-1)
        if (last?.attempt === attempt) {
          if (backendRequestId)
            last.backendRequestId = backendRequestId
        }
        else {
          value.attempts.push({ target, attempt, ...(backendRequestId ? { backendRequestId } : {}) })
        }
        await this.#save(conversationId, value)
      }),
      submitting: () => update(async () => {
        await this.#save(conversationId, { ...value, state: 'unknown' })
        value.state = 'unknown'
        receipt.submitted = true
      }),
      retain: outputs => update(async () => {
        const retainedOutputs = z.array(imageGenerationRetainedOutputSchema).parse(outputs)
        await this.#save(conversationId, { ...value, state: 'partial', retainedOutputs })
        value.state = 'partial'
        value.retainedOutputs = retainedOutputs
      }),
      complete: result => update(async () => {
        const saved = resultSchema.parse(result)
        await this.#save(conversationId, { ...value, state: 'completed', artifactIds: saved.artifactIds, responseId: saved.responseId, result: saved })
      }, true),
      fail: (failure, artifactIds = []) => update(async () => {
        await this.#save(conversationId, { ...value, state: failure.outcome, failure, ...(failure.retainedOutputs ? { retainedOutputs: failure.retainedOutputs } : {}), responseId: failure.diagnostic?.responseId ?? value.responseId, artifactIds: [...artifactIds] })
      }, true),
    }
    return receipt
  }

  #block(conversationId: string, value: Receipt): never {
    throw new ImageGenerationError('IMAGE_GENERATION_BLOCKED', {
      outcome: value.state === 'partial' ? 'partial' : 'unknown',
      request: this.#reference(conversationId, value),
      artifactIds: value.artifactIds,
      retainedOutputs: value.retainedOutputs,
      diagnostic: { ...value.failure?.diagnostic, stage: 'blocked', localRequestId: value.id },
    })
  }

  #reference(conversationId: string, value: Receipt): ImageRequestRef {
    return { conversationId, runId: value.runId, requestId: value.id }
  }

  async #readRun(conversationId: string, runId: string): Promise<Receipt[]> {
    z.uuid().parse(runId)
    const directory = join(this.paths.conversationDirectory(conversationId), 'image-requests', runId)
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return []
      throw error
    })
    const values: Receipt[] = []
    for (const name of names) {
      if (!name.endsWith('.json'))
        continue
      const value = receiptSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))
      if (value.runId !== runId || name !== `${value.id}.json`)
        throw new Error('IMAGE_REQUEST_INVALID')
      values.push(value)
    }
    return values
  }

  async #save(conversationId: string, value: Receipt): Promise<void> {
    const directory = join(this.paths.conversationDirectory(conversationId), 'image-requests', value.runId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
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

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation)
    this.#pending = result.catch(() => {})
    return result
  }
}
