import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyToolDisclosurePolicy } from '../agent/extensions/discovery/toolDiscoveryContract'
import type { ImageBlobStore } from '../attachments/ImageBlobStore'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageReadingMaterialWriter } from './ImageReadingMaterialStore'
import type { ImageReader, ImageReadingImage } from './ImageReadingService'
import { Buffer } from 'node:buffer'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { filePaths } from '../../../platform/filesystem/filePaths'
import { imageReadingLimits } from '../../../shared/images/ocrService'
import { readToolMediaReference } from '../agent/context/ToolMediaReference'
import { createToolClassificationFailure } from '../approvals/toolClassification'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { detectReadingImageMime } from './detectReadingImageMime'
import { imageReadingRequest } from './imageReadingRequest'
import { imageReadingToolResult } from './imageReadingToolResult'
import { IMAGE_TOOLS } from './imageToolGroup'

export const IMAGE_READING_TOOL_NAME = IMAGE_TOOLS.read.name
export const imageReadingParameters = Type.Object({
  images: Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), { minItems: 1, maxItems: imageReadingLimits.maxImages, uniqueItems: true, description: 'Image paths from attachment resources or generated outputs, or exact image:<sha256> references returned by tools. Order defines image numbers. Include all images needed for a comparison in one call.' }),
  question: Type.String({ minLength: 1, maxLength: 8192, description: 'The specific visual question to resolve, including what to compare or verify. The host also supplies the current user request.' }),
  operation: Type.Optional(Type.Union([Type.Literal('understand'), Type.Literal('extract'), Type.Literal('document')], { description: 'understand (default): visual questions and comparisons. extract: verbatim visible text only. document: headings, reading order and tables.' })),
})

export const IMAGE_READING_DISCLOSURE: BuddyToolDisclosurePolicy = {
  source: { kind: 'builtin', id: 'image_reading', title: 'Image understanding' },
  exposure: 'direct',
  keywords: 'image vision understand compare screenshot OCR inspect 图片 识图 看图 对比 截图 文字 提取',
  tools: [IMAGE_TOOLS.read],
}

export interface ImageReadingExtensionOptions {
  cwd: string
  store: ImageBlobStore
  readImage: ImageReader
  writeMaterial: ImageReadingMaterialWriter
  getGrants: (toolCallId: string) => readonly DirectoryGrant[]
}

export function createImageReadingCapability(options: ImageReadingExtensionOptions): BuddyCapability {
  return {
    classify(event) {
      if (event.toolName !== IMAGE_READING_TOOL_NAME)
        return null
      if (!Check(imageReadingParameters, event.input) || event.input.images.some(value => value.startsWith('image:') && !isImageReference(value)))
        return createToolClassificationFailure('VALIDATION_FAILED')
      return { access: 'read', paths: event.input.images.filter(value => !isImageReference(value)).map(path => ({ mode: 'existing', path })) }
    },
    disclosure: [IMAGE_READING_DISCLOSURE],
    extension: {
      name: 'lexora-image-reading',
      factory(pi) {
        pi.registerTool(createImageReadingTool(options))
      },
    },
  }
}

export function createImageReadingTool(options: ImageReadingExtensionOptions) {
  return defineTool({
    ...IMAGE_TOOLS.read,
    label: 'Inspect images',
    description: 'Answer visual questions about one or more images using the configured image reader. Accepts local paths and saved tool-image references. Returns images for native vision or sourced observations from the independent vision model; a text-only chat model can use this tool. This inspects images, it does not generate or deliver them.',
    parameters: imageReadingParameters,
    promptGuidelines: [
      'Use images already supplied natively directly. For images supplied only as paths or references, use lexora_image_read with a focused question. Send all relevant images together for comparisons; preserve their order and explain each role in the question. A prior description is limited evidence; inspect again for new details or uncertainty.',
      'Use understand for visual states, colors, positions, charts and image comparisons. extract transcribes text and cannot establish selected controls or switch states. To verify a generated or edited image, inspect its returned output path against the user requirements; successful generation alone does not establish visual correctness.',
    ],
    async execute(toolCallId, input, signal, _onUpdate, context) {
      if (!Check(imageReadingParameters, input) || !context.model)
        throw new Error('VALIDATION_FAILED')
      const executionSignal = signal ?? context.signal ?? new AbortController().signal
      executionSignal.throwIfAborted()
      const images: ImageReadingImage[] = []
      let remainingBytes: number = imageReadingLimits.inputBytes
      for (const reference of input.images) {
        executionSignal.throwIfAborted()
        const image = await readSource(reference, toolCallId, context, options, executionSignal, remainingBytes)
        remainingBytes -= Buffer.byteLength(image.image.data, 'base64')
        images.push(image)
      }
      const result = await options.readImage({
        images,
        request: imageReadingRequest(context),
        question: input.question,
        operation: input.operation ?? 'understand',
        model: context.model,
        signal: executionSignal,
      })
      return imageReadingToolResult(result, input.images, executionSignal, options.writeMaterial)
    },
  })
}

async function readSource(reference: string, toolCallId: string, context: ExtensionToolContext, options: ImageReadingExtensionOptions, signal: AbortSignal, remainingBytes: number): Promise<ImageReadingImage> {
  if (isImageReference(reference)) {
    const hash = reference.slice('image:'.length)
    for (const entry of context.sessionManager.getBranch()) {
      const media = entry.type === 'message' ? readToolMediaReference(entry.message) : null
      const image = media?.images.find(image => image.sha256 === hash)
      if (image) {
        if (image.sizeBytes > remainingBytes)
          throw new Error('IMAGE_READING_UNSUPPORTED')
        return { reference, image: { type: 'image', mimeType: image.mimeType, data: (await options.store.read({ sha256: image.sha256, sizeBytes: image.sizeBytes })).toString('base64') } }
      }
    }
    throw new Error('IMAGE_REFERENCE_UNAVAILABLE')
  }
  if (reference.startsWith('image:'))
    throw new Error('VALIDATION_FAILED')
  const path = filePaths.resolveInput(reference, context.cwd || options.cwd)
  const resolved = await resolveGrantedPath(options.getGrants(toolCallId), path, 'existing')
  const bytes = await readBoundedFile(resolved.root, resolved.canonicalPath, remainingBytes, signal)
  const mimeType = detectReadingImageMime(bytes)
  if (!mimeType)
    throw new Error('IMAGE_READING_UNSUPPORTED')
  signal.throwIfAborted()
  return { reference, image: { type: 'image', mimeType, data: bytes.toString('base64') } }
}

function isImageReference(value: string): boolean {
  return /^image:[\da-f]{64}$/.test(value)
}
