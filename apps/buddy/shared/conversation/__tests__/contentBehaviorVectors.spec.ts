import { describe, expect, it } from 'vitest'
import vectors from '../../productProtocol/content-behavior-vectors.json'
import { buddyUserContentToText, buddyUserContentV1Schema, createBuddyUserContent } from '../buddyUserContent'

describe('cross-client content behavior', () => {
  it.each(vectors.textCases)('$name retains line boundaries and UTF-16 content', (entry) => {
    const content = createBuddyUserContent(entry.text)
    expect(buddyUserContentToText(content)).toBe(entry.text)
    expect(content.body).toHaveLength(entry.desktopParagraphs)
  })
  it.each(vectors.contents)('$name preserves source metadata', (entry) => {
    const result = buddyUserContentV1Schema.safeParse(entry.value)
    expect(result.success).toBe(entry.valid)
    if (result.success)
      expect(buddyUserContentToText(result.data)).toBe(entry.desktopText)
  })
})
