import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { FileLinkMenuProvider } from '@/shared/ui/markdown/fileLinkMenu'
import type { MarkdownImageResolver } from '@/shared/ui/markdown/markdownImage'
import { createInjectionState } from '@vueuse/core'

interface ChatContentContext {
  openWebLink: (url: string) => void
  canPreviewFile: (path: string) => boolean
  previewFile: (path: string, source?: ContextPanelSource) => void
  fileLinkMenu?: (href: string, source?: ContextPanelSource) => ReturnType<FileLinkMenuProvider>
  createImageResolver?: (conversationId?: string) => MarkdownImageResolver
  onLinkError?: (error: unknown) => void
  writeClipboardText: (text: string) => Promise<void>
}

const [useProvideChatContent, injectChatContent] = createInjectionState(
  (context: ChatContentContext) => context,
)

export { useProvideChatContent }

export function useChatContent(): ChatContentContext {
  const context = injectChatContent()
  if (!context)
    throw new Error('Chat content context is unavailable')
  return context
}

export function tryUseChatContent(): ChatContentContext | null {
  return injectChatContent() ?? null
}
