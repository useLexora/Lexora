import { describe, expect, it } from 'vitest'
import { readTextMaterialPage } from '../textMaterialRead'

describe('text material pages', () => {
  it('preserves every UTF-16 unit across Unicode and long single-line pages within a byte budget', () => {
    const text = '字😀a\r\n'.repeat(1000)
    let offset: number | null = 0
    let restored = ''
    while (offset !== null) {
      const page = readTextMaterialPage(text, { offset, limit: 7, maxBytes: 9 })
      expect(new TextEncoder().encode(page.text).byteLength).toBeLessThanOrEqual(9)
      expect(page.range).toEqual({ unit: 'utf16', start: offset, end: offset + page.text.length })
      expect(page.text.isWellFormed()).toBe(true)
      expect(page.complete).toBe(page.nextOffset === null)
      restored += page.text
      offset = page.nextOffset
    }
    expect(restored).toBe(text)
  })

  it('budgets serialized text without undercounting control characters or JSON escapes', () => {
    const text = '\u0001\n\t\\"😀字'.repeat(20)
    let offset: number | null = 0
    let restored = ''
    while (offset !== null) {
      const page = readTextMaterialPage(text, { offset, limit: 100, maxJsonBytes: 17 })
      expect(new TextEncoder().encode(JSON.stringify(page.text)).byteLength).toBeLessThanOrEqual(17)
      restored += page.text
      offset = page.nextOffset
    }
    expect(restored).toBe(text)
  })

  it('does not return broken characters or a continuation that cannot make progress', () => {
    expect(readTextMaterialPage('a😀b', { limit: 2 })).toMatchObject({ text: 'a', nextOffset: 1 })
    expect(() => readTextMaterialPage('a😀b', { offset: 2 })).toThrow('TEXT_READ_OFFSET_INSIDE_SURROGATE_PAIR')
    expect(() => readTextMaterialPage('😀', { limit: 1 })).toThrow('TEXT_READ_LIMIT_TOO_SMALL_FOR_CHARACTER')
    expect(() => readTextMaterialPage('😀', { maxBytes: 3 })).toThrow('TEXT_READ_LIMIT_TOO_SMALL_FOR_CHARACTER')
    expect(readTextMaterialPage('', {})).toMatchObject({ text: '', complete: true, nextOffset: null })
    expect(readTextMaterialPage('a', { offset: 1 })).toMatchObject({ text: '', complete: true, nextOffset: null })
    expect(() => readTextMaterialPage('a', { offset: 2 })).toThrow('TEXT_READ_OFFSET_OUT_OF_RANGE')
  })
})
