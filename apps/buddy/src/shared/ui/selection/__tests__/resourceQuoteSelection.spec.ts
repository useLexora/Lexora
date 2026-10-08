// @vitest-environment jsdom
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it } from 'vitest'
import { readResourceTextSelection } from '../resourceQuoteSelection'

const source: BuddyResourceQuote['source'] = { kind: 'file', title: 'notes.md', file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'notes.md' }, format: 'markdown' }
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})
function select(start: Node, from: number, end = start, to = from + 6) {
  const range = document.createRange()
  range.setStart(start, from)
  range.setEnd(end, to)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  return window.getSelection()
}

describe('markdown selection capture', () => {
  it('captures a text snapshot and position without inventing source line numbers', () => {
    const root = document.createElement('article')
    root.textContent = 'before chosen after'
    document.body.append(root)
    const captured = readResourceTextSelection(root, select(root.firstChild!, 7), source)!
    expect(captured.text).toBe('chosen')
    expect(captured.textOffset).toBe(7)
    expect(captured.range).toBeUndefined()
    root.textContent = 'changed'
    expect(captured.text).toBe('chosen')
  })

  it('rejects selections crossing a control or excluded block, even with valid text endpoints', () => {
    const root = document.createElement('article')
    root.innerHTML = '<p>before</p><button>Copy</button><p>after</p>'
    document.body.append(root)
    expect(readResourceTextSelection(root, select(root.firstChild!.firstChild!, 0, root.lastChild!.firstChild!, 5), source)).toBeNull()
  })

  it('rejects collapsed, outside, cross-view and control selections', () => {
    const root = document.createElement('article')
    const other = document.createElement('article')
    root.innerHTML = '<p>chosen text</p><button>button</button>'
    other.textContent = 'outside'
    document.body.append(root, other)
    expect(readResourceTextSelection(root, null, source)).toBeNull()
    expect(readResourceTextSelection(root, select(root.firstChild!.firstChild!, 0, root.firstChild!.firstChild!, 0), source)).toBeNull()
    expect(readResourceTextSelection(root, select(other.firstChild!, 0), source)).toBeNull()
    expect(readResourceTextSelection(root, select(root.firstChild!.firstChild!, 0, other.firstChild!, 3), source)).toBeNull()
    expect(readResourceTextSelection(root, select(root.querySelector('button')!.firstChild!, 0), source)).toBeNull()
  })
})
