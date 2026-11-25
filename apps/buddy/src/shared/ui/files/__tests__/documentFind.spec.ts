import { describe, expect, it, vi } from 'vitest'
// @vitest-environment jsdom
import { effectScope } from 'vue'
import { documentFindRanges, findDocumentMatches, handleDocumentFindKey } from '../documentFind'
import { useDocumentFind } from '../useDocumentFind'

function article(html: string) {
  const root = document.createElement('article')
  root.innerHTML = html
  return root
}

describe('document find', () => {
  it('finds a phrase split by inline markup and keeps paragraph boundaries apart', () => {
    const root = article('<p>甲方采购<strong>合同</strong>项下</p><p>按合同约定</p>')
    const { ranges, capped } = documentFindRanges(root, '合同')
    expect(ranges.map(range => range.toString())).toEqual(['合同', '合同'])
    expect(capped).toBe(false)
    expect(documentFindRanges(root, '下按').ranges).toEqual([])
  })

  it('matches without case and skips buttons', () => {
    const root = article('<p>The Contract</p><button>contract</button>')
    expect(documentFindRanges(root, 'contract').ranges.map(range => range.toString())).toEqual(['Contract'])
  })

  it('reports a blank query as no search and caps the extra match', () => {
    expect(findDocumentMatches('合同合同', '  ')).toEqual({ starts: [], capped: false })
    expect(findDocumentMatches('aaaa', 'a', 2)).toEqual({ starts: [0, 1], capped: true })
  })

  it('opens from the document shortcut and moves the active match', () => {
    const scope = effectScope()
    const find = scope.run(() => useDocumentFind())!
    find.setResult(3, false)
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    const show = vi.spyOn(find, 'show')
    handleDocumentFindKey(event, { open: false, searchable: true, show: find.show, close: find.close, next: find.next, previous: find.previous })
    expect(event.defaultPrevented).toBe(true)
    expect(show).toHaveBeenCalledOnce()
    find.next()
    expect(find.index.value).toBe(1)
    find.previous()
    expect(find.index.value).toBe(0)
    find.index.value = 2
    find.query.value = '合同'
    expect(find.index.value).toBe(0)
    scope.stop()
  })
})
