import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { FileLinkMenuProvider } from '@/shared/ui/markdown/fileLinkMenu'
import { createInjectionState } from '@vueuse/core'

interface ChatContentContext {
  openWebLink: (url: string) => void
  canPreviewFile: (path: string) => boolean
  previewFile: (path: string, source?: ContextPanelSource) => void
  fileLinkMenu?: (href: string, source?: ContextPanelSource) => ReturnType<FileLinkMenuProvider>
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
