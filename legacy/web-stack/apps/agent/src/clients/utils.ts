import { APP_INTERNAL_KEY_HEADER } from '@haohaoxue/lexora-contracts'
import { z } from 'zod'

const ApiResponseEnvelopeSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown(),
}).passthrough()

export function normalizeApiInternalBaseUrl(apiInternalUrl: string): string {
  return apiInternalUrl.endsWith('/') ? apiInternalUrl : `${apiInternalUrl}/`
}

export async function postApiInternalJson(options: {
  baseUrl: string
  path: string
  payload: unknown
  errorMessage: string
  appInternalKey: string
}): Promise<unknown> {
  const response = await fetch(new URL(options.path, options.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [APP_INTERNAL_KEY_HEADER]: options.appInternalKey,
    },
    body: JSON.stringify(options.payload),
  })

  if (!response.ok) {
    throw new Error(`${options.errorMessage}: ${response.status}`)
  }

  return unwrapApiResponseData(await response.json())
}

export function unwrapApiResponseData(payload: unknown): unknown {
  const envelope = ApiResponseEnvelopeSchema.safeParse(payload)
  return envelope.success ? envelope.data.data : payload
}
