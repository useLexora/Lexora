import type { SyncTransport } from '../../../platform/sync/SyncAdapter'
import type { ImagePreferences } from '../../../shared/images/imagePreferences'
import type { OcrServiceConfig, OcrServiceStatus } from '../../../shared/images/ocrService'
import type { CredentialVault } from '../secrets/CredentialVault'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readLimitedResponse } from '../../../platform/sync/SyncAdapter'
import { isSeparateOcrEnabled } from '../../../shared/images/imagePreferences'
import { imageReadingLimits, ocrReadRequestSchema, ocrReadResultSchema, ocrServiceSaveSchema } from '../../../shared/images/ocrService'

const responseSchema = z.object({
  errorCode: z.literal(0),
  result: z.object({ ocrResults: z.array(z.object({ prunedResult: z.object({ rec_texts: z.array(z.string()) }) })).min(1).max(1) }),
})

export class OcrService {
  readonly options: {
    preferences: () => Promise<ImagePreferences>
    save: (service: OcrServiceConfig) => Promise<void>
    credentials: CredentialVault
    request: SyncTransport
  }

  #saving: Promise<unknown> = Promise.resolve()

  constructor(options: OcrService['options']) { this.options = options }

  async status(): Promise<OcrServiceStatus> {
    const { ocrService: service } = await this.options.preferences()
    return {
      service: service ? { api: service.api, endpoint: service.endpoint } : null,
      hasCredential: Boolean(service?.credentialId && await this.options.credentials.read('images', service.credentialId)),
    }
  }

  save(raw: unknown): Promise<OcrServiceStatus> {
    const input = ocrServiceSaveSchema.parse(raw)
    const operation = this.#saving.then(async () => {
      const current = (await this.options.preferences()).ocrService
      const changedEndpoint = current?.endpoint !== input.service.endpoint
      if (changedEndpoint && current?.credentialId && input.credential === undefined)
        throw new Error('OCR_CREDENTIAL_REQUIRED')
      const credentialId = typeof input.credential === 'string' ? randomUUID() : input.credential === null ? undefined : current?.credentialId
      if (typeof input.credential === 'string')
        await this.options.credentials.write('images', credentialId!, input.credential)
      try {
        await this.options.save({ ...input.service, ...(credentialId ? { credentialId } : {}) })
      }
      catch (error) {
        const persisted = (await this.options.preferences()).ocrService
        if (credentialId && credentialId !== current?.credentialId && persisted?.credentialId !== credentialId)
          await this.options.credentials.delete('images', credentialId).catch(() => {})
        throw error
      }
      if (current?.credentialId && current.credentialId !== credentialId)
        await this.options.credentials.delete('images', current.credentialId).catch(() => {})
      return this.status()
    })
    this.#saving = operation.catch(() => {})
    return operation
  }

  async read(raw: unknown, signal: AbortSignal) {
    const input = ocrReadRequestSchema.parse(raw)
    signal.throwIfAborted()
    const preferences = await this.options.preferences()
    if (!isSeparateOcrEnabled(preferences) || JSON.stringify(preferences.ocrService) !== JSON.stringify(input.service))
      throw new Error('OCR_SERVICE_CHANGED')
    const credential = input.service.credentialId ? await this.options.credentials.read('images', input.service.credentialId) : null
    if (input.service.credentialId && typeof credential !== 'string')
      throw new Error('OCR_CREDENTIAL_REQUIRED')
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(120000)])
    const response = await this.options.request(input.service.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(typeof credential === 'string' ? { Authorization: `Bearer ${credential}` } : {}) },
      body: Buffer.from(JSON.stringify({ file: input.image.data, fileType: 1, visualize: false })),
      signal: lifetime,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('OCR_REQUEST_FAILED')
    }
    const bytes = await readLimitedResponse(response, 4 * 1024 * 1024)
    lifetime.throwIfAborted()
    const result = responseSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    const text = result.result.ocrResults.flatMap(page => page.prunedResult.rec_texts).join('\n')
    if (Buffer.byteLength(text) > imageReadingLimits.textBytes)
      throw new Error('OCR_RESPONSE_TOO_LARGE')
    return ocrReadResultSchema.parse({ text })
  }
}
