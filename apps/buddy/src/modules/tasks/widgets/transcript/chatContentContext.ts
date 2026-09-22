import { createInjectionState } from '@vueuse/core'

interface ChatContentContext {
  canPreviewFile: (path: string) => boolean
  previewFile: (path: string) => void
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
