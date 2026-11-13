import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { ImageReferenceAccess } from './ImageReferenceAccess'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { createToolClassificationFailure } from '../approvals/toolClassification'
import { IMAGE_REFERENCE_LIST_LIMIT } from './ImageReferenceAccess'
import { IMAGE_TOOLS } from './imageToolGroup'

export const imageReferenceListParameters = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 256, description: 'Filter visible image names, referenceIds or source message/run IDs.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: IMAGE_REFERENCE_LIST_LIMIT, default: 20 })),
}, { additionalProperties: false })

export function createImageReferenceCapability(access: Pick<ImageReferenceAccess, 'list'>): BuddyCapability {
  return {
    classify(event, signal) {
      if (event.toolName !== IMAGE_TOOLS.list.name)
        return null
      if (!Check(imageReferenceListParameters, event.input))
        return createToolClassificationFailure('VALIDATION_FAILED')
      signal.throwIfAborted()
      return { access: 'read', paths: [] }
    },
    disclosure: [{
      source: { kind: 'builtin', id: 'image_reference', title: 'Image references' },
      exposure: 'on_demand',
      keywords: 'image reference attachment artifact list 图片 引用 附件 产物 目录',
      tools: [IMAGE_TOOLS.list],
    }],
    extension: {
      name: 'lexora-image-reference',
      factory(pi) {
        pi.registerTool(defineTool({
          ...IMAGE_TOOLS.list,
          label: 'List visible image references',
          description: 'List a bounded page of image attachments and artifacts visible to this execution on its accepted task branch. Returns explicit referenceId (attachmentId or artifactId), sourceKind, name, sourceMessageId, sourceRunId, path and image metadata. path locates the saved attachment or current artifact; reading still requires ordinary file authorization. query searches only names and IDs, not image contents. Does not import files, choose a reference, or expand file permissions.',
          parameters: imageReferenceListParameters,
          promptGuidelines: ['Use lexora_image_list to recover image reference IDs lost from context or compaction. Pass the exact returned referenceId to image generation; composer resourceId is a different identity. Keep the requested reference order and choose only the images relevant to the user request. sourceMessageId may be null for generated artifacts. The directory is metadata, not visual inspection or file access authorization.'],
          async execute(_id, input, signal) {
            if (!Check(imageReferenceListParameters, input))
              throw new Error('VALIDATION_FAILED')
            return { content: [{ type: 'text', text: JSON.stringify(access.list(input, signal ?? new AbortController().signal)) }], details: {} }
          },
        }))
      },
    },
  }
}
