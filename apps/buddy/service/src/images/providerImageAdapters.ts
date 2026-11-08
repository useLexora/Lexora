import type { ImageOutputOptions, ImageSupport } from '../../../shared/images/imagePreferences'
import type { ImageGenerationInput } from './ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { ImageGenerationError } from './ImageGenerationGateway'
import { nativeImageSupport } from './imageGenerationSupport'

interface ProviderImageRequest {
  path: 'images/generations' | 'images/edits'
  body: Record<string, unknown> | FormData
}

interface ProviderImageAdapter {
  support: ImageSupport
  buildRequest: (model: string, input: ImageGenerationInput, output: ImageOutputOptions) => ProviderImageRequest
}

const openAiImages: ProviderImageAdapter = {
  support: nativeImageSupport,
  buildRequest(model, input, output) {
    const fields = {
      model,
      prompt: input.prompt,
      n: 1,
      output_format: 'png',
      ...Object.fromEntries(Object.entries({ size: output.size, quality: output.quality, background: output.background }).filter(([, value]) => value !== 'auto')),
    }
    if (!input.inputImages.length)
      return { path: 'images/generations', body: fields }
    const body = new FormData()
    for (const [name, value] of Object.entries(fields))
      body.set(name, String(value))
    for (const [index, image] of prepareReferenceImages(input).entries())
      body.append('image[]', new Blob([image.bytes], { type: image.mimeType }), `reference-${index}.${image.mimeType.split('/')[1]}`)
    return { path: 'images/edits', body }
  },
}

const agnesImages: ProviderImageAdapter = {
  support: {
    operations: ['generate', 'edit'],
    maxReferenceImages: 6,
    sizes: [...nativeImageSupport.sizes],
    qualities: ['auto'],
    backgrounds: ['auto'],
    resolutions: ['1K', '2K', '3K', '4K'],
    aspectRatios: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'],
  },
  buildRequest(model, input, output) {
    const images = prepareReferenceImages(input).map(image => `data:${image.mimeType};base64,${image.bytes.toString('base64')}`)
    return {
      path: 'images/generations',
      body: {
        model,
        prompt: input.prompt,
        size: output.size === 'auto' ? output.resolution ?? '1K' : output.size,
        ...(output.size === 'auto' ? { ratio: output.aspectRatio ?? '1:1' } : {}),
        extra_body: {
          response_format: 'b64_json',
          ...(images.length ? { image: images } : {}),
        },
      },
    }
  },
}

const endpointAdapters = new Map<string, ProviderImageAdapter>([
  ['https://apihub.agnes-ai.com/v1', agnesImages],
  ['https://api.agnes-ai.cn/v1', agnesImages],
])

export function resolveProviderImageAdapter(baseUrl: string | null | undefined): ProviderImageAdapter {
  if (!baseUrl)
    return openAiImages
  return endpointAdapters.get(baseUrl.replace(/\/+$/, '')) ?? openAiImages
}

function prepareReferenceImages(input: ImageGenerationInput) {
  let total = 0
  return input.inputImages.map((image) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType))
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    const bytes = Buffer.from(image.data, 'base64')
    total += bytes.byteLength
    if (total > 32 * 1024 * 1024)
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    return { bytes, mimeType: image.mimeType }
  })
}
