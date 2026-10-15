import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { imageBlobReferenceSchema } from '../../attachments/ImageBlobStore'

const toolMediaReferenceSchema = z.object({
  version: z.literal(1),
  images: z.array(imageBlobReferenceSchema.extend({
    contentIndex: z.number().int().nonnegative(),
    mimeType: z.string().min(1),
  }).strict()).min(1).refine(images => new Set(images.map(image => image.contentIndex)).size === images.length),
}).strict()

export type ToolMediaReference = z.infer<typeof toolMediaReferenceSchema>
export interface ToolMediaReferenceMessage extends ToolResultMessage {
  buddyToolMedia: ToolMediaReference
}

export function readToolMediaReference(message: AgentSession['messages'][number]): ToolMediaReference | null {
  if (message.role !== 'toolResult' || !('buddyToolMedia' in message))
    return null
  return toolMediaReferenceSchema.parse(message.buddyToolMedia)
}
