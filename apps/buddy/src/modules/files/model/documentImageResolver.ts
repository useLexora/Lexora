import type { TaskFile, TaskFileLink, TaskFileTarget } from '@buddy-shared/files/taskFileApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { MarkdownImageResolver } from '@/shared/ui/markdown/markdownImage'
import { spaceFileMediaUrl, taskFileMediaUrl } from '@buddy-shared/files/mediaPreview'
import { documentRelativePath, isDocumentRelativeImage } from './documentRelativePath'

export function spaceFileImageResolver(target: SpaceFileTarget): MarkdownImageResolver {
  return documentImageResolver(target.path, path => spaceFileMediaUrl({ ...target, path }))
}

export function taskFileImageResolver(target: TaskFileTarget, resolve: (link: TaskFileLink) => Promise<TaskFile>): MarkdownImageResolver {
  return documentImageResolver(target.path, async (path) => {
    const file = await resolve({ conversationId: target.conversationId, href: encodeURIComponent(path) })
    return taskFileMediaUrl(file.target)
  })
}

function documentImageResolver(documentPath: string, resolve: (path: string) => string | Promise<string>): MarkdownImageResolver {
  return async (src) => {
    if (!isDocumentRelativeImage(src))
      return { kind: 'default' }
    const path = documentRelativePath(documentPath, src)
    return path ? { kind: 'local', src: await resolve(path) } : { kind: 'unavailable' }
  }
}
