import { describe, expect, it } from 'vitest'
import { findChatComposerTrigger } from '../chatComposerInput'

describe('findChatComposerTrigger', () => {
  it('recognizes the ideographic comma as a slash trigger like /', () => {
    expect(findChatComposerTrigger('、rev')).toEqual({ kind: 'slash', query: 'rev' })
    expect(findChatComposerTrigger('/rev')).toEqual({ kind: 'slash', query: 'rev' })
  })

  it('recognizes the fullwidth yuan sign as a skill trigger like $', () => {
    expect(findChatComposerTrigger('￥contract')).toEqual({ kind: 'skill', query: 'contract' })
    expect(findChatComposerTrigger('$contract')).toEqual({ kind: 'skill', query: 'contract' })
  })

  it('recognizes the fullwidth yuan sign mid-text after whitespace', () => {
    expect(findChatComposerTrigger('帮我用 ￥contract')).toEqual({ kind: 'skill', query: 'contract' })
  })

  it.each(['“', '”', '‘', '’', '（', '【'])('accepts the Chinese punctuation %s as a trigger boundary', (boundary) => {
    expect(findChatComposerTrigger(`${boundary}￥contract`)).toEqual({ kind: 'skill', query: 'contract' })
    expect(findChatComposerTrigger(`${boundary}$contract`)).toEqual({ kind: 'skill', query: 'contract' })
    expect(findChatComposerTrigger(`${boundary}@文件`)).toEqual({ kind: 'mention', query: '文件' })
  })

  it('does not trigger when preceded by a word character', () => {
    expect(findChatComposerTrigger('abc￥contract')).toBeNull()
    expect(findChatComposerTrigger('abc$contract')).toBeNull()
  })

  it('does not trigger when the query contains whitespace', () => {
    expect(findChatComposerTrigger('￥con tract')).toBeNull()
  })
})