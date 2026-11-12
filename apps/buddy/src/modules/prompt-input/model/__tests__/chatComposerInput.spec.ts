import { describe, expect, it } from 'vitest'
import { findChatComposerTrigger } from '../chatComposerInput'

describe('findChatComposerTrigger', () => {
  it.each([['、', '/'], ['￥', '$']])('recognizes %s only when Chinese input triggers are enabled', (alias, ascii) => {
    expect(findChatComposerTrigger(`${alias}review`)).toBeNull()
    expect(findChatComposerTrigger(`${alias}review`, true)).toEqual(findChatComposerTrigger(`${ascii}review`))
    expect(findChatComposerTrigger(`${alias}re view`, true)).toBeNull()
    expect(findChatComposerTrigger(`word${alias}review`, true)).toBeNull()
  })

  it('keeps slash commands at the start but allows skills mid-text without rewriting the query', () => {
    expect(findChatComposerTrigger('正文 、review', true)).toBeNull()
    expect(findChatComposerTrigger('正文 ￥a、b', true)).toEqual({ kind: 'skill', query: 'a、b' })
    expect(findChatComposerTrigger('$first ￥second', true)).toEqual({ kind: 'skill', query: 'second' })
  })

  it('accepts Chinese punctuation boundaries independently of the alias setting', () => {
    expect(findChatComposerTrigger('“$review')).toEqual({ kind: 'skill', query: 'review' })
    expect(findChatComposerTrigger('（@文件')).toEqual({ kind: 'mention', query: '文件' })
    expect(findChatComposerTrigger('【￥review', true)).toEqual({ kind: 'skill', query: 'review' })
  })
})
