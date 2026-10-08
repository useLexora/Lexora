import type { Input, MouseInputEvent } from 'electron'
import type { BrowserLocateElementInput, BrowserPickResult } from '../../../shared/browser/browserSelection'
import type { BrowserDebugger } from './BrowserDebugger'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { browserPickResultSchema } from '../../../shared/browser/browserSelection'
import { BROWSER_ELEMENT_PICKER_SCRIPT } from './browserElementPickerScript'

interface ActivePick {
  requestId: string
  key: string
  contextId: number | null
  resolve: (result: BrowserPickResult) => void
  selecting: boolean
  timeout: ReturnType<typeof setTimeout>
}
const runtimeValueSchema = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() })

/** Native input is intercepted before the page can click links or submit forms. */
export class BrowserElementPicker {
  #active: ActivePick | null = null
  #swallowRelease = false
  #moving = false
  #disposed = false
  readonly connection: BrowserDebugger
  readonly zoom: () => number
  constructor(connection: BrowserDebugger, zoom: () => number) {
    this.connection = connection
    this.zoom = zoom
  }

  start(requestId: string): Promise<BrowserPickResult> {
    this.cancel()
    return new Promise((resolve) => {
      const active: ActivePick = { requestId, key: `__lexoraPicker-${randomUUID()}`, contextId: null, resolve, selecting: false, timeout: setTimeout(() => this.cancel(requestId), 120_000) }
      this.#active = active
      void this.#createContext(active.key).then(async (contextId) => {
        active.contextId = contextId
        if (this.#active !== active || this.#disposed) {
          await this.#cleanup(contextId, active.key)
        }
      }).catch(() => this.#finish(active, { status: 'unavailable' }))
    })
  }

  cancel(requestId?: string): void {
    const active = this.#active
    if (active && (!requestId || active.requestId === requestId))
      this.#finish(active, { status: 'cancelled' })
  }

  handleKey(input: Input): boolean {
    if (!this.#active)
      return false
    if (input.key === 'Escape') {
      this.cancel()
      return true
    }
    // Do not allow Enter/Space to activate an element while collecting.
    return true
  }

  handleMouse(input: MouseInputEvent, source: () => Extract<BrowserPickResult, { status: 'selected' }>['source']): boolean {
    if (input.type === 'mouseUp' && this.#swallowRelease) {
      this.#swallowRelease = false
      return true
    }
    const active = this.#active
    if (!active)
      return false
    const x = input.x / this.zoom()
    const y = input.y / this.zoom()
    if (input.type === 'mouseMove' && active.contextId && !this.#moving && !active.selecting) {
      this.#moving = true
      void this.#evaluate(active.contextId, `globalThis[${JSON.stringify(active.key)}].move(${JSON.stringify(x)},${JSON.stringify(y)})`).catch(() => this.#finish(active, { status: 'unavailable' })).finally(() => this.#moving = false)
    }
    if (input.type === 'mouseDown') {
      this.#swallowRelease = true
      if (input.button === 'left' && active.contextId && !active.selecting) {
        active.selecting = true
        const capturedSource = source()
        void this.#evaluate(active.contextId, `globalThis[${JSON.stringify(active.key)}].pick(${JSON.stringify(x)},${JSON.stringify(y)})`).then((result) => {
          const raw = result && typeof result === 'object' && 'status' in result && result.status === 'selected' ? { ...result, source: capturedSource } : result
          const parsed = browserPickResultSchema.safeParse(raw)
          this.#finish(active, parsed.success ? parsed.data : { status: 'limit' })
        }).catch(() => this.#finish(active, { status: 'unavailable' }))
      }
    }
    return ['mouseDown', 'mouseUp', 'contextMenu'].includes(input.type)
  }

  async locate(input: BrowserLocateElementInput, current: () => boolean = () => true): Promise<boolean> {
    this.cancel()
    const key = `__lexoraPicker-${randomUUID()}`
    const contextId = await this.#createContext(key)
    try {
      if (!current()) {
        await this.#cleanup(contextId, key)
        return false
      }
      const result = await this.#evaluate(contextId, `globalThis[${JSON.stringify(key)}].locate(${JSON.stringify(input.element.selector)},${JSON.stringify(input.element.tagName)},${JSON.stringify(input.text)})`)
      if (result === true && current()) {
        setTimeout(() => void this.#cleanup(contextId, key), 1400)
        return true
      }
      await this.#cleanup(contextId, key)
      return false
    }
    catch {
      await this.#cleanup(contextId, key)
      return false
    }
  }

  dispose(): void {
    this.#disposed = true
    this.cancel()
  }

  async #createContext(key: string): Promise<number> {
    this.connection.ensureAttached()
    const tree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) }).parse(await this.connection.sendCommand('Page.getFrameTree'))
    const { executionContextId } = z.object({ executionContextId: z.number().int() }).parse(await this.connection.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'lexora-element-reference' }))
    await this.#evaluate(executionContextId, `globalThis[${JSON.stringify(key)}] = ${BROWSER_ELEMENT_PICKER_SCRIPT}; true`)
    return executionContextId
  }

  async #evaluate(contextId: number, expression: string): Promise<unknown> {
    const result = runtimeValueSchema.parse(await this.connection.sendCommand('Runtime.evaluate', { contextId, expression, returnByValue: true }))
    if (result.exceptionDetails)
      throw new Error('Element reference evaluation failed')
    return result.result.value
  }

  async #cleanup(contextId: number, key: string): Promise<void> {
    try {
      await this.#evaluate(contextId, `globalThis[${JSON.stringify(key)}]?.dispose(); delete globalThis[${JSON.stringify(key)}]`)
    }
    catch { /* Navigation destroys the old world. */ }
  }

  #finish(active: ActivePick, result: BrowserPickResult): void {
    if (this.#active !== active)
      return
    this.#active = null
    clearTimeout(active.timeout)
    if (active.contextId)
      void this.#cleanup(active.contextId, active.key)
    active.resolve(result)
  }
}
