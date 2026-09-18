export function createChatTranscriptDomIndex(content: HTMLElement) {
  let dirty = true
  let rows: HTMLElement[] = []
  let messages: HTMLElement[] = []
  const rowsByKey = new Map<string, HTMLElement>()
  const messagesById = new Map<string, HTMLElement>()
  const observer = new MutationObserver(() => {
    dirty = true
  })
  observer.observe(content, { childList: true })

  function refresh() {
    if (observer.takeRecords().length)
      dirty = true
    if (!dirty)
      return
    dirty = false
    rows = []
    messages = []
    rowsByKey.clear()
    messagesById.clear()
    for (const element of content.children) {
      if (!(element instanceof HTMLElement))
        continue
      if (element.dataset.chatRowKey) {
        rows.push(element)
        rowsByKey.set(element.dataset.chatRowKey, element)
      }
      if (element.dataset.messageId) {
        messages.push(element)
        messagesById.set(element.dataset.messageId, element)
      }
    }
  }

  return {
    dispose: () => observer.disconnect(),
    findMessage(messageId: string) {
      refresh()
      return messagesById.get(messageId) ?? null
    },
    findRow(rowKey: string) {
      refresh()
      return rowsByKey.get(rowKey) ?? null
    },
    firstRowBelow(top: number) {
      refresh()
      return firstElementBelow(rows, top)
    },
    firstMessageBelow(top: number) {
      refresh()
      return firstElementBelow(messages, top)
    },
  }
}

function firstElementBelow(elements: readonly HTMLElement[], top: number): HTMLElement | null {
  let start = 0
  let end = elements.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (elements[middle].getBoundingClientRect().bottom <= top)
      start = middle + 1
    else
      end = middle
  }
  return elements[start] ?? null
}
