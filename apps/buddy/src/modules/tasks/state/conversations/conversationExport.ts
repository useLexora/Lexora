import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversationTimelineItem, LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import { readonly, shallowRef } from 'vue'
import { ConversationExportSizeError, formatConversationMarkdown } from '../../model/transcript/conversationMarkdown'

export interface ConversationExportOptions {
  api: Pick<LocalChatApi['conversations'], 'get' | 'listTimeline'>
  clipboard: { writeText: (text: string) => Promise<void> }
  maxReadBytes?: number
  maxMarkdownBytes?: number
}

export function createConversationExport(options: ConversationExportOptions) {
  const busy = shallowRef(false)
  return {
    busy: readonly(busy),
    async copy(conversationId: string, fallbackTitle: string, language: 'zh-CN' | 'en-US'): Promise<{ title: string } | null> {
      if (busy.value)
        return null
      busy.value = true
      try {
        const conversation = await options.api.get(conversationId)
        if (conversation.deletedAt || conversation.id !== conversationId)
          throw new Error('Conversation is no longer available')
        const branchId = conversation.activeBranchId
        const title = conversation.title || fallbackTitle
        const items = new Set<string>()
        const runs = new Map<string, LocalConversationTimelinePage['runs'][number]>()
        const events = new Map<string, LocalConversationTimelinePage['runEvents'][number]>()
        const outputs = new Map<string, LocalConversationTimelinePage['outputs'][number]>()
        const itemPages: LocalConversationTimelineItem[][] = []
        const cursors = new Set<string>()
        const encoder = new TextEncoder()
        let readBytes = 0
        let cursor: string | undefined
        if (branchId) {
          do {
            const page = await options.api.listTimeline({ conversationId, branchId, cursor, limit: 500 })
            readBytes += encoder.encode(JSON.stringify(page)).byteLength
            if (readBytes > (options.maxReadBytes ?? 64 * 1024 * 1024))
              throw new ConversationExportSizeError()
            const newItems: LocalConversationTimelineItem[] = []
            for (const item of page.items) {
              const key = `${item.kind}:${item.id}`
              if (!items.has(key)) {
                items.add(key)
                newItems.push(item)
              }
            }
            itemPages.push(newItems)
            // Keep each run's first snapshot; older pages may contain newer events.
            const newRunIds = new Set(page.runs.filter(run => !runs.has(run.id)).map(run => run.id))
            for (const run of page.runs) {
              if (!runs.has(run.id))
                runs.set(run.id, run)
            }
            for (const event of page.runEvents) {
              if (newRunIds.has(event.runId))
                events.set(`${event.runId}:${event.sequence}`, event)
            }
            for (const output of page.outputs) {
              const key = `${output.runId}:${output.sourceToolCallId}`
              if (newRunIds.has(output.runId) && !outputs.has(key))
                outputs.set(key, output)
            }
            cursor = page.nextCursor ?? undefined
            if (cursor && (cursors.has(cursor) || cursors.size >= 2_000))
              throw new Error('Conversation export pagination did not advance')
            if (cursor) {
              cursors.add(cursor)
              // Yield so progress feedback can paint during long reads.
              await new Promise(resolve => setTimeout(resolve, 0))
            }
          } while (cursor)
        }
        const markdown = formatConversationMarkdown({
          conversation,
          title,
          language,
          exportedAt: new Date().toISOString(),
          maxBytes: options.maxMarkdownBytes,
          timeline: {
            items: itemPages.reverse().flat(),
            runs: [...runs.values()],
            runEvents: [...events.values()],
            outputs: [...outputs.values()],
            changeSets: [],
            nextCursor: null,
          },
        })
        // Do not copy a conversation deleted during a long read.
        const current = await options.api.get(conversationId)
        if (current.deletedAt || current.id !== conversationId)
          throw new Error('Conversation is no longer available')
        await options.clipboard.writeText(markdown)
        return { title }
      }
      finally {
        busy.value = false
      }
    },
  }
}

export type ConversationExport = ReturnType<typeof createConversationExport>
