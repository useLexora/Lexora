import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InputModel } from '../../providers/modelCapabilities'
import type { BuddyInputReferenceV1 } from './BuddyInputReference'
import { supportsModelFileInput } from '../../providers/modelCapabilities'
import { base64BytesLength, getModelImageLimits, getModelImageResize } from '../../providers/modelInputBudget'

export interface ImageRequestBudget {
  remainingBytes: number
  remainingImages: number
  remainingMessageImages: number
}

export function projectMessageImages(message: AgentSession['messages'][number], model: InputModel, budget?: ImageRequestBudget): AgentSession['messages'][number] {
  if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content))
    return message
  let remaining = budget?.remainingMessageImages ?? getModelImageLimits(model).maxPerMessage
  let changed = false
  const content = message.content.map((block) => {
    if (block.type !== 'image')
      return block
    const bytes = block.data.length + 512
    if (model.input.includes('image') && remaining > 0 && block.data.length <= getModelImageResize(model).maxBytes
      && (!budget || (budget.remainingImages > 0 && bytes <= budget.remainingBytes))) {
      remaining--
      if (budget) {
        budget.remainingImages--
        budget.remainingMessageImages--
        budget.remainingBytes -= bytes
      }
      return block
    }
    changed = true
    return { type: 'text' as const, text: '[Image content is not supplied to the current model. Use available file paths for file operations; do not claim to have seen this image.]' }
  })
  return changed ? { ...message, content } : message
}

export function projectBuddyInput(
  reference: BuddyInputReferenceV1,
  model: InputModel,
  sizes: ReadonlyMap<string, number>,
  remainingBytes = Number.POSITIVE_INFINITY,
  remainingImages = Number.POSITIVE_INFINITY,
): { input: BuddyInputReferenceV1, bytes: number } {
  let bytes = 0
  const fits = (id: string) => {
    const size = base64BytesLength(sizes.get(id) ?? 0) + 512
    if (!Number.isFinite(size) || bytes + size > remainingBytes)
      return false
    bytes += size
    return true
  }
  let imageCount = Math.min(remainingImages, getModelImageLimits(model).maxPerMessage)
  const images = reference.images.filter((file) => {
    if (!model.input.includes('image') || imageCount <= 0 || !fits(file.attachmentId))
      return false
    imageCount--
    return true
  })
  const documents = reference.documents?.filter(file => supportsModelFileInput(model, file.mimeType) && fits(file.attachmentId))
  return {
    bytes,
    input: {
      ...reference,
      attachmentIds: reference.attachmentIds ?? [...reference.images, ...reference.documents ?? []].map(file => file.attachmentId),
      images,
      documents,
    },
  }
}
