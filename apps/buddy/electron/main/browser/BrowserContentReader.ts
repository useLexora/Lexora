import type { BrowserErrorCode } from '../../../shared/browser'
import type { BrowserReadContent, BrowserReadOptions, BrowserReadSource } from '../../../shared/browser/reading'
import type { BrowserDebugger } from './BrowserDebugger'
import type { SemanticBrowserTarget } from './browserObservationProjection'
import type { SemanticBrowserObservationInput } from './SemanticBrowserDriver'
import { randomUUID } from 'node:crypto'
import { BROWSER_MAX_OBSERVATION_TEXT_BYTES } from '../../../shared/browser'
import { browserReadContentSchema, browserReadSourceSchema } from '../../../shared/browser/reading'
import { cdpDocumentSchema, cdpIsolatedWorldSchema, cdpResolveNodeSchema, cdpRuntimeResultSchema } from './browserCdpSchemas'
import { BrowserHostError } from './BrowserHostError'
import { collectFrameIds } from './browserObservationProjection'
import { redactBrowserRuntimeUrl } from './browserPrivacy'
import { BROWSER_READ_FUNCTION } from './browserReadScript'

interface StoredRead {
  content: Omit<BrowserReadContent, 'cursor' | 'items' | 'truncated'>
  expiresAt: number
  items: BrowserReadSource['items']
}

export class BrowserContentReader {
  readonly #reads = new Map<string, StoredRead>()
  readonly #now: () => number
  readonly #ttlMs: number
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(now: () => number, ttlMs: number) {
    this.#now = now
    this.#ttlMs = ttlMs
  }

  async read(input: BrowserReadOptions & Omit<SemanticBrowserObservationInput, 'mode'>, context: {
    assertCurrent: () => void
    connection: BrowserDebugger
    documentRevision: number
    resolveTarget: (target: NonNullable<BrowserReadOptions['target']>) => SemanticBrowserTarget
  }): Promise<BrowserReadContent> {
    this.#prune()
    let readId: string
    let offset = 0
    if (input.cursor) {
      const [id, position] = input.cursor.split(':')
      readId = id
      offset = Number(position)
    }
    else {
      readId = randomUUID()
      const { connection } = context
      const objectGroup = `lexora-browser-read-${readId}`
      try {
        const target = input.target ? context.resolveTarget(input.target) : null
        if (target && target.frameId !== input.target?.frameId)
          throw readFailure('BROWSER_TARGET_STALE')
        const [documentResult, frameResult] = await Promise.all([
          connection.sendCommand('DOM.getDocument', { depth: 0, pierce: true }),
          connection.sendCommand('Page.getFrameTree'),
        ])
        const document = cdpDocumentSchema.parse(documentResult)
        const frameId = target?.frameId ?? document.root.frameId ?? collectFrameIds(frameResult).frameIds[0]
        if (!frameId)
          throw readFailure('BROWSER_PAGE_FAILED')
        const world = cdpIsolatedWorldSchema.parse(await connection.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'lexora-browser-read' }))
        const resolved = cdpResolveNodeSchema.parse(await connection.sendCommand('DOM.resolveNode', {
          backendNodeId: target?.backendDOMNodeId ?? document.root.backendNodeId,
          executionContextId: world.executionContextId,
          objectGroup,
        }))
        const result = cdpRuntimeResultSchema.parse(await connection.sendCommand('Runtime.callFunctionOn', {
          arguments: [{ value: input.mode ?? 'text' }, { value: input.selector ?? null }],
          functionDeclaration: BROWSER_READ_FUNCTION,
          objectId: resolved.object.objectId,
          returnByValue: true,
        }))
        if (result.exceptionDetails)
          throw readFailure('BROWSER_PAGE_FAILED')
        const value = result.result.value
        if (value && typeof value === 'object' && 'error' in value)
          throw readFailure(value.error === 'invalid-selector' ? 'BROWSER_READ_INVALID_SELECTOR' : 'BROWSER_TARGET_STALE')
        const source = browserReadSourceSchema.parse(value)
        context.assertCurrent()
        const items = source.items.map((item) => {
          if (item.kind !== 'link')
            return item
          const url = redactBrowserRuntimeUrl(item.url)
          return { ...item, url, ...(url !== item.url ? { urlRedacted: true } : {}) }
        })
        this.#reads.set(readId, {
          content: {
            documentRevision: context.documentRevision,
            frameId,
            mode: input.mode ?? 'text',
            pageId: input.pageId,
            sessionId: input.sessionId,
            sourceTruncated: source.sourceTruncated,
            title: input.title.slice(0, 512),
            url: redactBrowserRuntimeUrl(source.url),
          },
          expiresAt: this.#now() + this.#ttlMs,
          items,
        })
        while (this.#reads.size > 4)
          this.#reads.delete(this.#reads.keys().next().value!)
        this.#scheduleExpiry()
      }
      finally {
        await connection.sendCommand('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
      }
    }
    context.assertCurrent()
    const stored = this.#reads.get(readId)
    if (!stored || stored.content.pageId !== input.pageId || stored.content.sessionId !== input.sessionId || stored.content.documentRevision !== context.documentRevision || offset > stored.items.length)
      throw readFailure('BROWSER_TARGET_STALE')
    const items: BrowserReadSource['items'] = []
    let next = offset
    while (next < stored.items.length && items.length < (input.maxItems ?? 40)) {
      const candidate = { ...stored.content, items: [...items, stored.items[next]], cursor: `${readId}:${next + 1}`, truncated: true }
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > BROWSER_MAX_OBSERVATION_TEXT_BYTES)
        break
      items.push(stored.items[next++])
    }
    if (!items.length && next < stored.items.length)
      throw readFailure('BROWSER_PAGE_FAILED')
    return browserReadContentSchema.parse({
      ...stored.content,
      ...(next < stored.items.length ? { cursor: `${readId}:${next}` } : {}),
      items,
      truncated: next < stored.items.length || stored.content.sourceTruncated,
    })
  }

  clear(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#reads.clear()
  }

  #prune(): void {
    for (const [id, read] of this.#reads) {
      if (read.expiresAt <= this.#now())
        this.#reads.delete(id)
    }
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#timer)
    if (!this.#reads.size)
      return
    const expiresAt = Math.min(...[...this.#reads.values()].map(read => read.expiresAt))
    this.#timer = setTimeout(() => {
      this.#prune()
      this.#scheduleExpiry()
    }, Math.max(1, expiresAt - this.#now()))
    this.#timer.unref()
  }
}

function readFailure(code: BrowserErrorCode): BrowserHostError {
  return new BrowserHostError(code, code)
}
