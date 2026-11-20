import type { LocalAttachment } from '@buddy-shared/conversation/attachmentApi'
import type { BuddyComposerResource } from '@buddy-shared/conversation/composerResource'
import type { BuddyLocalResource } from '@buddy-shared/conversation/localResource'
import { isImageMimeType } from '@buddy-shared/files/fileMimeTypes'
import { taskFileMediaUrl } from '@buddy-shared/files/mediaPreview'

export { getChatImageLabels } from '@buddy-shared/conversation/imageLabels'

export function resolveBuddyAttachmentPreviewUrl(attachment: LocalAttachment): string | null {
  if (attachment.kind !== 'image')
    return null
  return attachment.previewUrl
    ?? `lexora-attachment://preview/${encodeURIComponent(attachment.attachmentId)}`
}

export function resolveMessageResourcePreviewUrl(resource: LocalAttachment | BuddyLocalResource, conversationId: string): string | null {
  if ('attachmentId' in resource)
    return resolveBuddyAttachmentPreviewUrl(resource)
  return resource.kind === 'file' && isImageMimeType(resource.mimeType)
    ? taskFileMediaUrl({ conversationId, path: resource.path })
    : null
}

export function resolveComposerResourcePreviewUrl(resource: BuddyComposerResource): string | null {
  if (resource.state !== 'ready' || resource.kind !== 'image')
    return null
  if ('attachmentId' in resource)
    return resource.previewUrl ?? `lexora-attachment://preview/${encodeURIComponent(resource.attachmentId)}`
  if ('localReference' in resource.source)
    return `lexora-attachment://local-preview/${encodeURIComponent(resource.draftId)}/${encodeURIComponent(resource.resourceId)}`
  if ('attachmentId' in resource.source)
    return `lexora-attachment://preview/${encodeURIComponent(resource.source.attachmentId)}`
  if ('artifactId' in resource.source)
    return `lexora-artifact://preview/${encodeURIComponent(resource.source.artifactId)}`
  return null
}
