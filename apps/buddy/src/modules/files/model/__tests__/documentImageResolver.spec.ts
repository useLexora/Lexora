import { describe, expect, it } from 'vitest'
import { spaceFileImageResolver, taskFileImageResolver } from '../documentImageResolver'

describe('document image resolvers', () => {
  it('serves a space file image by its directory binding', () => {
    const resolve = spaceFileImageResolver({ spaceId: 's1', directoryId: 'd1', revision: 3, path: '教程/评论区.md' })
    const url = new URL(resolve('%E6%88%AA%E5%9B%BE/a.png')!)
    expect(url.protocol).toBe('lexora-file:')
    expect(url.hostname).toBe('media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ spaceId: 's1', directoryId: 'd1', revision: '3', path: '教程/截图/a.png' })
  })

  it('serves a task file image by its absolute path', () => {
    const resolve = taskFileImageResolver({ conversationId: 'c1', path: 'C:\\work\\report\\a.md' })
    const url = new URL(resolve('img/b.png')!)
    expect(url.hostname).toBe('task-media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ conversationId: 'c1', path: 'C:\\work\\report\\img\\b.png' })
  })

  it('does not rewrite remote or escaping addresses', () => {
    const resolve = spaceFileImageResolver({ spaceId: 's1', directoryId: 'd1', revision: 3, path: 'a.md' })
    expect(resolve('https://example.test/a.png')).toBeNull()
    expect(resolve('../outside.png')).toBeNull()
  })
})
