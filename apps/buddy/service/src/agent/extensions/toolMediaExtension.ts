import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ImageBlobStore } from '../../attachments/ImageBlobStore'
import type { ToolMediaReferenceMessage } from '../context/ToolMediaReference'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { readToolMediaReference } from '../context/ToolMediaReference'

export function createToolMediaExtension(store: ImageBlobStore): BuddyInProcessExtension {
  return {
    name: 'lexora-tool-media',
    factory(pi) {
      pi.on('message_end', async ({ message }) => {
        if (message.role !== 'toolResult' || readToolMediaReference(message))
          return
        const images: ToolMediaReferenceMessage['buddyToolMedia']['images'] = []
        const content = []
        for (const [contentIndex, block] of message.content.entries()) {
          if (block.type !== 'image' || !block.data) {
            content.push(block)
            continue
          }
          images.push({ ...await store.put(block.data), contentIndex, mimeType: block.mimeType })
          content.push({ ...block, data: '' })
        }
        if (images.length) {
          content.push({ type: 'text' as const, text: `Saved image references (in order): ${images.map(image => `image:${image.sha256}`).join(', ')}. Use lexora_image_read with these references for focused inspection or comparison when needed.` })
          return { message: { ...message, content, buddyToolMedia: { version: 1, images } } satisfies ToolMediaReferenceMessage }
        }
      })
    },
  }
}

export async function materializeToolMedia(messages: readonly AgentSession['messages'][number][], store: ImageBlobStore): Promise<AgentSession['messages']> {
  const result: AgentSession['messages'] = []
  for (const message of messages) {
    const reference = readToolMediaReference(message)
    if (!reference || message.role !== 'toolResult') {
      result.push(message)
      continue
    }
    const content = [...message.content]
    for (const image of reference.images) {
      const block = content[image.contentIndex]
      if (!block)
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
      if (block.type !== 'image')
        continue
      if (block.data || block.mimeType !== image.mimeType)
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
      content[image.contentIndex] = { ...block, data: (await store.read({ sha256: image.sha256, sizeBytes: image.sizeBytes })).toString('base64') }
    }
    if (content.some(block => block.type === 'image' && !block.data))
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    result.push({ ...message, content })
  }
  return result
}
