import { describe, expect, it } from 'vitest'
import { documentRelativePath } from '../documentRelativePath'

describe('documentRelativePath', () => {
  it('resolves an image beside a document inside a root and decodes its path', () => {
    expect(documentRelativePath('评论区教程.md', '%E6%88%AA%E5%9B%BE/%E6%95%99%E7%A8%8B-1.png')).toBe('截图/教程-1.png')
    expect(documentRelativePath('docs/guide/readme.md', './img/a%20b.png')).toBe('docs/guide/img/a b.png')
    expect(documentRelativePath('docs/guide/readme.md', '../shared/a.png?raw=1#top')).toBe('docs/shared/a.png')
  })

  it('treats backslashes in the image address as separators', () => {
    expect(documentRelativePath('docs/readme.md', '%E6%88%AA%E5%9B%BE%5Ca.png')).toBe('docs/截图/a.png')
  })

  it('refuses to climb above the root of a relative document', () => {
    expect(documentRelativePath('readme.md', '../a.png')).toBeNull()
    expect(documentRelativePath('docs/readme.md', '../../a.png')).toBeNull()
    expect(documentRelativePath('docs/readme.md', '..')).toBeNull()
  })

  it('keeps the drive and separator style of an absolute document', () => {
    expect(documentRelativePath('/home/lenovo/notes/a.md', 'img/b.png')).toBe('/home/lenovo/notes/img/b.png')
    expect(documentRelativePath('C:\\Users\\Lenovo\\notes\\a.md', '../img/b%20c.png')).toBe('C:\\Users\\Lenovo\\img\\b c.png')
    expect(documentRelativePath('C:/notes/a.md', 'img/b.png')).toBe('C:/notes/img/b.png')
  })

  it('preserves UNC share roots and refuses to climb above them', () => {
    expect(documentRelativePath(String.raw`\\server\share\docs\a.md`, '../img/b.png')).toBe(String.raw`\\server\share\img\b.png`)
    expect(documentRelativePath('//server/share/docs/a.md', 'img/b.png')).toBe('//server/share/docs/img/b.png')
    expect(documentRelativePath(String.raw`\\server\share\a.md`, '../b.png')).toBeNull()
  })

  it('leaves addresses that are not paths beside the document alone', () => {
    for (const src of ['', 'https://example.test/a.png', 'data:image/png;base64,AAAA', 'lexora-file://media/?a=1', 'C:/a.png', '//cdn.test/a.png', '/a.png', '\\a.png', '#top', '?x=1'])
      expect(documentRelativePath('docs/readme.md', src)).toBeNull()
    expect(documentRelativePath('docs/readme.md', '%E0%A4%A.png')).toBeNull()
    expect(documentRelativePath('docs/readme.md', 'a%00.png')).toBeNull()
  })
})
