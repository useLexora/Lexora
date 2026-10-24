// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { copyReferenceClipboard, readReferenceClipboard } from '../referenceClipboard'

function quote() {
  return { id: crypto.randomUUID(), text: 'Selected <content>\r\n第二行', source: { kind: 'view' as const, title: 'Report.pdf', provider: 'extension:tests.office', target: { extensionId: 'tests.office', viewId: crypto.randomUUID(), viewType: 'tests.office.editor', source: null } }, locator: { version: 1, data: { documentId: 'private-document', page: 3 } } }
}
afterEach(() => vi.restoreAllMocks())
async function copy(snapshot = quote()) {
  let html = ''
  let text = ''
  await copyReferenceClipboard(snapshot, async (plain, rich) => {
    text = plain
    html = rich!
  })
  return { snapshot, html, text }
}

it('round-trips a trusted snapshot while keeping opaque identity out of the system clipboard', async () => {
  const result = await copy()
  expect(result.text).toBe(`${result.snapshot.source.title}\n${result.snapshot.text}`)
  expect(result.html).not.toContain('private-document')
  expect(result.html).not.toContain(result.snapshot.id)
  expect(result.html).toContain('&lt;content&gt;')
  expect(readReferenceClipboard(result.html)).toEqual(result.snapshot)
  const restored = readReferenceClipboard(result.html)!
  expect(restored).not.toBe(result.snapshot)
})

it('does not turn forged, altered or mixed external HTML into a reference', async () => {
  const result = await copy()
  expect(readReferenceClipboard(`<blockquote data-lexora-reference="${crypto.randomUUID()}">fake</blockquote>`)).toBeNull()
  expect(readReferenceClipboard(result.html.replace('Selected', 'Different'))).toBeNull()
  expect(readReferenceClipboard(`${result.html}<p>Different instruction</p>`)).toBeNull()
  expect(readReferenceClipboard(result.html + result.html)).toBeNull()
})

it('does not authorize failed clipboard writes, expired tokens or tokens from another app session', async () => {
  let failedHtml = ''
  await expect(copyReferenceClipboard(quote(), async (_text, html) => {
    failedHtml = html!
    throw new Error('Clipboard unavailable')
  })).rejects.toThrow('Clipboard unavailable')
  expect(readReferenceClipboard(failedHtml)).toBeNull()
  const copied = await copy()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000 + 1)
  expect(readReferenceClipboard(copied.html)).toBeNull()
  vi.restoreAllMocks()
  const session = await copy()
  vi.resetModules()
  const fresh = await import('../referenceClipboard')
  expect(fresh.readReferenceClipboard(session.html)).toBeNull()
})
