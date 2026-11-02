import type { TaskFileTarget } from '@buddy-shared/files/taskFileApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { MarkdownImageResolver } from '@/shared/ui/markdown/markdownImage'
import { spaceFileMediaUrl, taskFileMediaUrl } from '@buddy-shared/files/mediaPreview'
import { documentRelativePath } from '@/shared/ui/markdown/markdownImage'

// Images a document references by a path beside it load through the same media routes as the file itself, so the service keeps checking access.
export function spaceFileImageResolver(target: SpaceFileTarget): MarkdownImageResolver {
  return (src) => {
    const path = documentRelativePath(target.path, src)
    return path ? spaceFileMediaUrl({ ...target, path }) : null
  }
}

export function taskFileImageResolver(target: TaskFileTarget): MarkdownImageResolver {
  return (src) => {
    const path = documentRelativePath(target.path, src)
    return path ? taskFileMediaUrl({ conversationId: target.conversationId, path }) : null
  }
}
