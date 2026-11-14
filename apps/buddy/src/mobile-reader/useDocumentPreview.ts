import { onMounted, onUnmounted, shallowRef } from 'vue'
import { z } from 'zod'
import { setMarkdownLanguage } from './markdownStrings'

const documentSchema = z.object({
  text: z.string().max(65536),
  dark: z.boolean(),
  language: z.enum(['zh', 'en']),
  fontScale: z.number().min(0.5).max(3),
  appearance: z.record(z.string(), z.string()),
  canQuote: z.boolean(),
  labels: z.object({ body: z.string(), quote: z.string() }),
})

export function useDocumentPreview() {
  const document = shallowRef<z.infer<typeof documentSchema> | null>(null)
  const selection = shallowRef('')
  let port: MessagePort | undefined
  function send(action: string, text: string) {
    port?.postMessage(JSON.stringify({ action, text }))
  }
  function select() {
    const text = window.getSelection()?.toString().trim() ?? ''
    selection.value = text.length <= 8000 ? text : ''
  }
  function connect(event: MessageEvent) {
    if (event.data !== 'lexora-document' || !event.isTrusted || event.source !== null || !event.ports[0])
      return
    port?.close()
    port = event.ports[0]
    port.onmessage = (message: MessageEvent<string>) => {
      try {
        const parsed = documentSchema.safeParse(JSON.parse(message.data))
        if (parsed.success) {
          setMarkdownLanguage(parsed.data.language)
          document.value = parsed.data
          window.document.documentElement.lang = parsed.data.language === 'zh' ? 'zh-CN' : 'en'
          window.document.title = parsed.data.labels.body
        }
      }
      catch {}
    }
    port.start()
    send('ready', '')
  }
  onMounted(() => {
    window.addEventListener('message', connect)
    window.document.addEventListener('selectionchange', select)
  })
  onUnmounted(() => {
    window.removeEventListener('message', connect)
    window.document.removeEventListener('selectionchange', select)
    port?.close()
  })
  return { document, selection, send }
}
