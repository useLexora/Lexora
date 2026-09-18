// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createChatTranscriptDomIndex } from '../chatTranscriptDomIndex'

describe('chat transcript DOM index', () => {
  it('locates reading anchors across variable height rows without measuring the entire history', () => {
    const content = document.createElement('div')
    let measurements = 0
    let top = 0
    const bounds: Array<{ top: number, bottom: number }> = []
    for (let index = 0; index < 1000; index += 1) {
      const bottom = top + (index % 3 + 1) * 20
      bounds.push({ top, bottom })
      const element = document.createElement('article')
      element.dataset.chatRowKey = `row-${index}`
      if (index % 5)
        element.dataset.messageId = `message-${index}`
      element.getBoundingClientRect = () => {
        measurements += 1
        return bounds[index] as DOMRect
      }
      content.append(element)
      top = bottom
    }
    const index = createChatTranscriptDomIndex(content)
    try {
      expect(index.firstRowBelow(bounds[800].top + 10)?.dataset.chatRowKey).toBe('row-800')
      expect(index.firstMessageBelow(bounds[800].top + 10)?.dataset.messageId).toBe('message-801')
      expect(measurements).toBeLessThan(24)
      expect(index.firstRowBelow(top)).toBeNull()
      expect(index.firstRowBelow(-10)?.dataset.chatRowKey).toBe('row-0')
      bounds[800].bottom += 5
      expect(index.firstRowBelow(bounds[800].bottom - 1)?.dataset.chatRowKey).toBe('row-800')
    }
    finally { index.dispose() }
  })

  it('invalidates same-length row replacements and prepends before the next observer callback', () => {
    const content = document.createElement('div')
    const first = document.createElement('article')
    first.dataset.chatRowKey = 'first'
    first.dataset.messageId = 'first'
    content.append(first)
    const index = createChatTranscriptDomIndex(content)
    try {
      expect(index.findMessage('first')).toBe(first)
      const replacement = first.cloneNode() as HTMLElement
      replacement.dataset.chatRowKey = 'replacement'
      replacement.dataset.messageId = 'replacement'
      content.replaceChildren(replacement)
      expect(index.findMessage('first')).toBeNull()
      expect(index.findRow('replacement')).toBe(replacement)
      content.prepend(first)
      expect(index.findMessage('first')).toBe(first)
      first.remove()
      expect(index.findRow('first')).toBeNull()
    }
    finally { index.dispose() }
  })
})
