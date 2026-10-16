import type { BrowserReadOptions, BrowserReadSource } from '../../../../shared/browser/reading'
import { describe, expect, it, vi } from 'vitest'
import { browserReadOptionsSchema } from '../../../../shared/browser/reading'
import { BrowserContentReader } from '../BrowserContentReader'
import { BrowserDebugger } from '../BrowserDebugger'

const PAGE_ID = 'ed312709-baf9-44b3-a292-108055838477'
const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'
const OBSERVATION_ID = 'b3a5d63b-17b7-4b5a-863a-37f135e297d4'
const identity = { pageId: PAGE_ID, sessionId: SESSION_ID, status: 'ready' as const, title: 'Fixture', url: 'https://example.com/report?token=private' }

function fixture(source: BrowserReadSource) {
  let now = 0
  const reader = new BrowserContentReader(() => now, 1_000)
  const connection = new BrowserDebugger({
    attach() {},
    detach() {},
    isAttached: () => true,
    sendCommand: vi.fn(async (method) => {
      if (method === 'DOM.getDocument')
        return { root: { backendNodeId: 1 } }
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main-frame' } } }
      if (method === 'Page.createIsolatedWorld')
        return { executionContextId: 7 }
      if (method === 'DOM.resolveNode')
        return { object: { objectId: 'root' } }
      if (method === 'Runtime.callFunctionOn')
        return { result: { value: structuredClone(source) } }
      return {}
    }),
  })
  const context = { assertCurrent() {}, connection, documentRevision: 0, resolveTarget: () => ({ actions: [], backendDOMNodeId: 9, frameId: 'main-frame', name: '', role: 'heading' }) }
  const read = (options: BrowserReadOptions = {}) => reader.read({ ...identity, ...options }, context)
  return { context, read, reader, advance: () => {
    now += 1_001
  } }
}

describe('browser content reading', () => {
  it('paginates a captured UTF-8 read within the protocol budget without losing or mixing content', async () => {
    const original = Array.from({ length: 35 }, (_, index) => ({ kind: 'text' as const, text: `${index}:${'界'.repeat(2_000)}` }))
    const source = { items: [...original], sourceTruncated: false, url: identity.url }
    const { read, reader } = fixture(source)
    try {
      let page = await read()
      const items = [...page.items]
      expect(page.url).toBe('https://example.com/report')
      expect(page.cursor).toBeDefined()
      source.items = [{ kind: 'text', text: 'Later page content' }]
      while (page.cursor) {
        page = await read({ cursor: page.cursor })
        expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(32 * 1_024)
        items.push(...page.items)
      }
      expect(items).toEqual(original)
      expect(page.truncated).toBe(false)
    }
    finally { reader.clear() }
  })

  it('rejects foreign and expired cursors and preserves URL redaction metadata', async () => {
    const { read, reader, advance, context } = fixture({
      items: [{ kind: 'link', text: 'Report', url: identity.url }, { kind: 'link', text: 'Next', url: 'https://example.com/next' }],
      sourceTruncated: false,
      url: identity.url,
    })
    try {
      const first = await read({ mode: 'links', maxItems: 1 })
      expect(first.items).toEqual([{ kind: 'link', text: 'Report', url: 'https://example.com/report', urlRedacted: true }])
      await expect(reader.read({ ...identity, pageId: OBSERVATION_ID, cursor: first.cursor }, context)).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
      advance()
      await expect(read({ cursor: first.cursor })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
    }
    finally { reader.clear() }
  })

  it('rejects mismatched frame references and read inputs that combine separate scopes', async () => {
    const { read, reader } = fixture({ items: [], sourceTruncated: false, url: identity.url })
    try {
      await expect(read({ target: { documentRevision: 0, frameId: 'other-frame', observationId: OBSERVATION_ID, ref: 'e1' } })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
      expect(browserReadOptionsSchema.safeParse({ cursor: `${OBSERVATION_ID}:1`, selector: 'main' }).success).toBe(false)
      expect(browserReadOptionsSchema.safeParse({ selector: 'main', target: { documentRevision: 0, frameId: 'main-frame', observationId: OBSERVATION_ID, ref: 'e1' } }).success).toBe(false)
    }
    finally { reader.clear() }
  })
})
