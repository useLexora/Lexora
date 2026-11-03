// @vitest-environment jsdom
import type { Range } from '@tanstack/vue-virtual'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useChatTranscriptRetention } from '../useChatTranscriptRetention'

const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  document.getSelection()?.removeAllRanges()
})

async function mountTranscript(startIndex = 2, endIndex = 4) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = shallowRef<HTMLElement | null>(null)
  const keys = shallowRef(Array.from({ length: 20 }, (_, index) => `row-${index}`))
  const editingKey = shallowRef<string | null>(null)
  const range = shallowRef<Range>({ startIndex, endIndex, count: 20, overscan: 1 })
  let extractor!: ReturnType<typeof useChatTranscriptRetention>
  const app = createApp({
    setup() {
      extractor = useChatTranscriptRetention(root, keys, editingKey)
      return () => h('section', { ref: root }, extractor.value(range.value).map(index => h('article', {
        'key': keys.value[index],
        'data-virtual-row-key': keys.value[index],
      }, [h('span', `Message ${index}`), h('button', 'Edit')])))
    },
  })
  app.mount(host)
  let mounted = true
  function unmount() {
    if (mounted) {
      app.unmount()
      mounted = false
    }
  }
  cleanups.push(() => {
    unmount()
    host.remove()
  })
  await nextTick()

  function row(index: number) {
    const element = host.querySelector<HTMLElement>(`[data-virtual-row-key="row-${index}"]`)
    if (!element)
      throw new Error(`Row ${index} is not mounted`)
    return element
  }
  return {
    editingKey,
    host,
    keys,
    root,
    row,
    unmount,
    indexes: () => extractor.value(range.value),
    renderedKeys: () => [...host.querySelectorAll<HTMLElement>('[data-virtual-row-key]')].map(element => element.dataset.virtualRowKey),
    async scrollTo(start: number, end: number) {
      range.value = { ...range.value, startIndex: start, endIndex: end }
      await nextTick()
    },
  }
}

function textIn(row: HTMLElement) {
  return row.querySelector('span')!.firstChild!
}

function selectText(start: Node, end: Node = start) {
  const selection = document.getSelection()!
  const range = document.createRange()
  range.setStart(start, 1)
  range.setEnd(end, 4)
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

function pointerDown(target: HTMLElement, button = 0) {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }))
}

describe('chat transcript interaction retention', () => {
  it('retains an offscreen text selection and recycles its row after the selection is cleared', async () => {
    const fixture = await mountTranscript()
    expect(fixture.indexes()).toEqual([1, 2, 3, 4, 5])
    selectText(textIn(fixture.row(2)))
    await fixture.scrollTo(10, 12)
    expect(fixture.indexes()).toEqual([2, 9, 10, 11, 12, 13])
    expect(document.getSelection()!.toString()).toBe('ess')
    expect(fixture.renderedKeys()).toEqual(['row-2', 'row-9', 'row-10', 'row-11', 'row-12', 'row-13'])

    document.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await nextTick()
    expect(fixture.indexes()).toEqual([9, 10, 11, 12, 13])
    expect(fixture.renderedKeys()).toEqual(['row-9', 'row-10', 'row-11', 'row-12', 'row-13'])
  })

  it('retains every row of a cross-row selection in either selection direction', async () => {
    const fixture = await mountTranscript(2, 6)
    const start = textIn(fixture.row(2))
    const end = textIn(fixture.row(6))
    selectText(start, end)
    const selectedText = document.getSelection()!.toString()
    await fixture.scrollTo(12, 14)
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 11, 12, 13, 14, 15])
    expect(document.getSelection()!.toString()).toBe(selectedText)
    expect(fixture.row(4).textContent).toBe('Message 4Edit')

    document.getSelection()!.setBaseAndExtent(end, 4, start, 1)
    document.dispatchEvent(new Event('selectionchange'))
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 11, 12, 13, 14, 15])
    document.getSelection()!.collapse(start, 1)
    document.dispatchEvent(new Event('selectionchange'))
    await nextTick()
    expect(fixture.indexes()).toEqual([11, 12, 13, 14, 15])
    expect(fixture.renderedKeys()).toEqual(['row-11', 'row-12', 'row-13', 'row-14', 'row-15'])
  })

  it('retains all logical rows when the selection covers the whole row container', async () => {
    const fixture = await mountTranscript()
    const selectedRow = fixture.row(2)
    document.getSelection()!.selectAllChildren(fixture.root.value!)
    document.dispatchEvent(new Event('selectionchange'))
    await nextTick()
    expect(fixture.row(19).isConnected).toBe(true)
    const selectedText = document.getSelection()!.toString()
    expect(selectedText).toContain('Message 0')
    expect(selectedText).toContain('Message 19')
    await fixture.scrollTo(10, 12)
    expect(fixture.indexes()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(fixture.row(2)).toBe(selectedRow)
    expect(selectedRow.isConnected).toBe(true)
    expect(document.getSelection()!.toString()).toBe(selectedText)

    document.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await nextTick()
    expect(fixture.indexes()).toEqual([9, 10, 11, 12, 13])
    expect(fixture.renderedKeys()).toEqual(['row-9', 'row-10', 'row-11', 'row-12', 'row-13'])
    expect(selectedRow.isConnected).toBe(false)
  })

  it.each(['both', 'start', 'end'])('retains intersected rows when %s selection endpoints belong to the row container', async (endpoints) => {
    const fixture = await mountTranscript()
    const selectedRow = fixture.row(3)
    const root = fixture.root.value!
    const range = document.createRange()
    range.setStart(endpoints === 'end' ? textIn(fixture.row(2)) : root, 1)
    range.setEnd(endpoints === 'start' ? textIn(fixture.row(4)) : root, 4)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await fixture.scrollTo(10, 12)
    expect(fixture.indexes()).toEqual([2, 3, 4, 9, 10, 11, 12, 13])
    expect(fixture.row(3)).toBe(selectedRow)
    expect(selectedRow.isConnected).toBe(true)
    expect(selection.toString()).toContain('Message 3')

    selection.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await nextTick()
    expect(fixture.indexes()).toEqual([9, 10, 11, 12, 13])
    expect(fixture.renderedKeys()).toEqual(['row-9', 'row-10', 'row-11', 'row-12', 'row-13'])
    expect(selectedRow.isConnected).toBe(false)
  })

  it('keeps focused and editing rows independently and releases them when their interaction ends', async () => {
    const fixture = await mountTranscript()
    const button = fixture.row(2).querySelector('button')!
    button.focus()
    fixture.editingKey.value = 'row-4'
    await fixture.scrollTo(10, 12)
    expect(document.activeElement).toBe(button)
    expect(fixture.indexes()).toEqual([2, 4, 9, 10, 11, 12, 13])

    fixture.row(10).querySelector('button')!.focus()
    await nextTick()
    expect(fixture.indexes()).toEqual([4, 9, 10, 11, 12, 13])
    fixture.row(10).querySelector('button')!.blur()
    fixture.editingKey.value = null
    await nextTick()
    expect(fixture.indexes()).toEqual([9, 10, 11, 12, 13])
    expect(fixture.renderedKeys()).toEqual(['row-9', 'row-10', 'row-11', 'row-12', 'row-13'])
  })

  it.each(['pointerup', 'pointercancel', 'blur'])('retains the drag anchor through scrolling and releases it on window %s', async (event) => {
    const fixture = await mountTranscript()
    pointerDown(fixture.row(2).querySelector('span')!)
    await fixture.scrollTo(8, 10)
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    await fixture.scrollTo(12, 14)
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])

    window.dispatchEvent(new Event(event))
    await nextTick()
    expect(fixture.indexes()).toEqual([11, 12, 13, 14, 15])
    expect(fixture.renderedKeys()).toEqual(['row-11', 'row-12', 'row-13', 'row-14', 'row-15'])
  })

  it('keeps the completed selection but releases the drag-only bridge after pointerup', async () => {
    const fixture = await mountTranscript()
    pointerDown(fixture.row(2))
    await fixture.scrollTo(8, 10)
    selectText(textIn(fixture.row(2)), textIn(fixture.row(8)))
    await fixture.scrollTo(12, 14)
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    window.dispatchEvent(new Event('pointerup'))
    await nextTick()
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15])
    expect(document.getSelection()!.isCollapsed).toBe(false)
  })

  it('does not retain unrelated document selections or secondary-button drags', async () => {
    const fixture = await mountTranscript()
    const outside = document.createElement('p')
    outside.dataset.virtualRowKey = 'row-0'
    outside.textContent = 'Outside transcript'
    fixture.host.append(outside)
    selectText(outside.firstChild!)
    pointerDown(fixture.row(2), 2)
    await fixture.scrollTo(10, 12)
    expect(fixture.indexes()).toEqual([9, 10, 11, 12, 13])
  })

  it.each(['selectionchange', 'pointerdown', 'focusin', 'focusout'])('disconnects the document or root %s listener on unmount', async (event) => {
    const fixture = await mountTranscript()
    const root = fixture.root.value!
    root.remove()
    fixture.unmount()
    fixture.host.append(root)
    fixture.root.value = root
    await nextTick()

    if (event === 'selectionchange')
      selectText(textIn(fixture.row(2)))
    else if (event === 'pointerdown')
      pointerDown(fixture.row(3))
    else if (event === 'focusin')
      fixture.row(4).querySelector('button')!.focus()
    else
      fixture.row(2).dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: fixture.row(4) }))
    await fixture.scrollTo(10, 12)
    expect(fixture.indexes()).toEqual([9, 10, 11, 12, 13])
  })

  it.each(['pointerup', 'pointercancel', 'blur'])('disconnects the window %s listener on unmount', async (event) => {
    const fixture = await mountTranscript()
    pointerDown(fixture.row(2))
    await fixture.scrollTo(10, 12)
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    fixture.unmount()
    window.dispatchEvent(new Event(event))
    expect(fixture.indexes()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })
})
