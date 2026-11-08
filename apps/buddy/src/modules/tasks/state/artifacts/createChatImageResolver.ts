import type { TaskFile, TaskFileLink } from '@buddy-shared/files/taskFileApi'
import type { MarkdownImageResolver } from '@/shared/ui/markdown/markdownImage'
import { localFileLinkPath } from '@buddy-shared/files/fileLink'
import { isImageMimeType } from '@buddy-shared/files/fileMimeTypes'
import { taskFileMediaUrl } from '@buddy-shared/files/mediaPreview'

export function createChatImageResolver(conversationId: string | null, resolve: (link: TaskFileLink) => Promise<TaskFile>): MarkdownImageResolver {
  return async (src) => {
    if (src.startsWith('//') || localFileLinkPath(src) === null)
      return { kind: 'default' }
    if (!conversationId)
      return { kind: 'unavailable' }
    const file = await resolve({ conversationId, href: src })
    return file.kind === 'file' && isImageMimeType(file.mimeType)
      ? { kind: 'local', src: taskFileMediaUrl(file.target) }
      : { kind: 'unavailable' }
  }
}
