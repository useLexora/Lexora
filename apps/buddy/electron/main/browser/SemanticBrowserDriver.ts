import type { z } from 'zod'
import type {
  BrowserAction,
  BrowserErrorCode,
  BrowserFailureReason,
  BrowserObservation,
  BrowserObservationTruncation,
  BrowserScreenshotRef,
} from '../../../shared/browser'
import type { BrowserObservationHeader, SemanticBrowserTarget } from './browserObservationProjection'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:process'
import {
  BROWSER_MAX_OBSERVATION_TEXT_BYTES,
  BROWSER_MAX_SCREENSHOT_BYTES,
  browserObservationSchema,
  getBrowserActionRef,
  getBrowserObservationTextByteLength,
} from '../../../shared/browser'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import { browserTargetActionabilitySchema, cdpAxTreeSchema, cdpBoxModelSchema, cdpDocumentSchema, cdpDomSnapshotSchema, cdpLayoutMetricsSchema, cdpResolveNodeSchema, cdpRuntimeResultSchema } from './browserCdpSchemas'
import { BrowserDebugger } from './BrowserDebugger'
import { collectDomFieldMetadata, collectFrameIds, collectViewportNodeIds, containsSensitiveFieldMetadata, createScreenshotRef, createTruncation, deduplicateAccessibilityNodes, getScreenshotFallbackReasons, hasPngSignature, hasVisualContent, MAX_OBSERVED_FRAMES, normalizeElementLimit, projectElements, scopeAccessibilityNodes } from './browserObservationProjection'
import {
  projectBrowserObservedValue,
  redactBrowserRuntimeUrl,
} from './browserPrivacy'

interface SemanticBrowserPage {
  capturePage: () => Promise<{
    getSize: () => { height: number, width: number }
    toPNG: () => Uint8Array
  }>
  debugger: {
    attach: (protocolVersion?: string) => void
    detach: () => void
    isAttached: () => boolean
    sendCommand: (
      method: string,
      commandParams?: Record<string, unknown>,
    ) => Promise<unknown>
  }
}

interface SemanticBrowserDriverOptions {
  connection?: BrowserDebugger
  createId?: () => string
  createScreenshotId?: () => string
  maxObservations?: number
  now?: () => number
  observationTtlMs?: number
  page: SemanticBrowserPage
}

export interface SemanticBrowserObservationInput {
  maxElements?: number
  pageId: string
  sessionId: string
  status: BrowserObservation['status']
  title: string
  url: string
}

export interface SemanticBrowserActionInput {
  action: BrowserAction
  documentRevision: number
  frameId?: string
  observationId: string
}

export interface SemanticBrowserTargetReference {
  documentRevision: number
  observationId: string
  ref: string
}

export interface SemanticBrowserScreenshotReference {
  documentRevision: number
  observationId: string
  screenshotId: string
}

export interface SemanticBrowserScreenshot {
  bytes: Uint8Array
  mimeType: 'image/png'
}

export type { SemanticBrowserTarget } from './browserObservationProjection'

interface StoredObservation {
  documentRevision: number
  expiresAt: number
  requiresHumanInput: boolean
  screenshot?: {
    bytes: Uint8Array
    ref: BrowserScreenshotRef
  }
  targets: Map<string, SemanticBrowserTarget>
}

type SemanticBrowserDriverErrorCode = Extract<
  BrowserErrorCode,
  | 'BROWSER_HUMAN_INPUT_REQUIRED'
  | 'BROWSER_PAGE_FAILED'
  | 'BROWSER_TARGET_STALE'
>

const DEFAULT_MAX_OBSERVATIONS = 8
const DEFAULT_OBSERVATION_TTL_MS = 30_000
const MAX_SCREENSHOT_CACHE_BYTES = 32 * 1_024 * 1_024
const BROWSER_ACTION_OBJECT_GROUP = 'lexora-browser-action'
const BROWSER_TARGET_ACTIONABILITY_FUNCTION = `async function (checkClickability) {
  const element = this
  const emptyFieldMetadata = { ariaLabel: '', autocomplete: '', id: '', label: '', name: '', placeholder: '', type: '' }
  if (!(element instanceof Element) || !element.isConnected) {
    return { connected: false, covered: false, disabled: true, editable: false, fieldMetadata: emptyFieldMetadata, focusable: false, readOnly: true, selectable: false, stable: false, visible: false }
  }
  const readFieldText = value => typeof value === 'string' ? value.slice(0, 1024) : ''
  const nativeLabels = 'labels' in element && element.labels
    ? Array.from(element.labels).slice(0, 16).map(label => label.textContent || '').join(' ')
    : ''
  const labelledBy = readFieldText(element.getAttribute('aria-labelledby')).split(/\\s+/).filter(Boolean).slice(0, 16)
    .map(id => element.ownerDocument.getElementById(id)?.textContent || '').join(' ')
  const fieldMetadata = {
    ariaLabel: readFieldText(element.getAttribute('aria-label')),
    autocomplete: readFieldText(element.getAttribute('autocomplete')),
    id: readFieldText(element.id),
    label: readFieldText(nativeLabels + ' ' + labelledBy),
    name: readFieldText(element.getAttribute('name')),
    placeholder: readFieldText(element.getAttribute('placeholder')),
    type: readFieldText(element instanceof HTMLInputElement ? element.type : element.getAttribute('type')),
  }
  const view = element.ownerDocument.defaultView
  const style = view?.getComputedStyle(element)
  const before = element.getBoundingClientRect()
  let after = before
  if (checkClickability && view) {
    await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)))
    after = element.getBoundingClientRect()
  }
  const centerX = after.left + after.width / 2
  const centerY = after.top + after.height / 2
  const hit = checkClickability ? element.ownerDocument.elementFromPoint(centerX, centerY) : element
  const covered = checkClickability && (!hit || (hit !== element && !element.contains(hit)))
  const stable = !checkClickability || (
    Math.abs(before.left - after.left) <= 0.5
    && Math.abs(before.top - after.top) <= 0.5
    && Math.abs(before.width - after.width) <= 0.5
    && Math.abs(before.height - after.height) <= 0.5
  )
  const disabled = ('disabled' in element && Boolean(element.disabled)) || element.getAttribute('aria-disabled') === 'true'
  const readOnly = ('readOnly' in element && Boolean(element.readOnly)) || element.getAttribute('aria-readonly') === 'true'
  const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable
  const focusable = element.tabIndex >= 0 || editable || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || (element instanceof HTMLAnchorElement && Boolean(element.href))
  return {
    connected: true,
    covered,
    disabled,
    editable,
    fieldMetadata,
    focusable,
    readOnly,
    selectable: element instanceof HTMLSelectElement,
    stable,
    visible: Boolean(style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && after.width > 0 && after.height > 0),
  }
}`
const BROWSER_SELECT_FUNCTION = `function (values) {
  if (!(this instanceof HTMLSelectElement) || !this.isConnected || this.disabled)
    return false
  const requested = new Set(values)
  const available = new Set(Array.from(this.options, option => option.value))
  if (values.some(value => !available.has(value)) || (!this.multiple && values.length !== 1))
    return false
  for (const option of this.options)
    option.selected = requested.has(option.value)
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}`
const BROWSER_SCROLL_TARGET_FUNCTION = `function (direction, amount) {
  if (!(this instanceof Element) || !this.isConnected)
    return false
  let container = this.parentElement
  while (container) {
    const style = container.ownerDocument.defaultView?.getComputedStyle(container)
    if (style && /(auto|scroll)/.test(style.overflowY) && container.scrollHeight > container.clientHeight)
      break
    container = container.parentElement
  }
  const target = container || this.ownerDocument.scrollingElement
  if (!target)
    return false
  const viewport = container ? container.clientHeight : this.ownerDocument.defaultView?.innerHeight || 0
  target.scrollBy({ behavior: 'instant', top: (direction === 'down' ? 1 : -1) * viewport * (amount === 'page' ? 1 : 0.5) })
  return true
}`

export class SemanticBrowserDriverError extends Error {
  readonly code: SemanticBrowserDriverErrorCode
  readonly reason: BrowserFailureReason | null

  constructor(
    code: SemanticBrowserDriverErrorCode = 'BROWSER_PAGE_FAILED',
    reason: BrowserFailureReason | null = null,
  ) {
    super(code === 'BROWSER_TARGET_STALE'
      ? 'Browser target reference is stale'
      : code === 'BROWSER_HUMAN_INPUT_REQUIRED'
        ? 'Browser input requires human control'
        : 'Browser semantic observation failed')
    this.code = code
    this.reason = reason
    this.name = 'SemanticBrowserDriverError'
  }
}

export class SemanticBrowserDriver {
  readonly #createId: () => string
  readonly #createScreenshotId: () => string
  readonly #maxObservations: number
  readonly #now: () => number
  readonly #observations = new Map<string, StoredObservation>()
  #observationExpiryTimer: ReturnType<typeof setTimeout> | null = null
  readonly #observationTtlMs: number
  readonly #page: SemanticBrowserPage
  #documentRevision = 0
  #disposed = false
  readonly #connection: BrowserDebugger
  readonly #ownsConnection: boolean

  constructor(options: SemanticBrowserDriverOptions) {
    this.#createId = options.createId ?? randomUUID
    this.#createScreenshotId = options.createScreenshotId ?? randomUUID
    this.#maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS
    this.#now = options.now ?? Date.now
    this.#observationTtlMs = options.observationTtlMs ?? DEFAULT_OBSERVATION_TTL_MS
    this.#page = options.page
    this.#connection = options.connection ?? new BrowserDebugger(options.page.debugger)
    this.#ownsConnection = !options.connection
  }

  async observe(input: SemanticBrowserObservationInput): Promise<BrowserObservation> {
    try {
      this.#assertActive()
      this.#ensureDebugger()
      const [
        frameTreeResult,
        documentResult,
        domSnapshotResult,
        layoutMetricsResult,
      ] = await Promise.all([
        this.#connection.sendCommand('Page.getFrameTree'),
        this.#connection.sendCommand('DOM.getDocument', {
          depth: 0,
          pierce: true,
        }),
        this.#connection.sendCommand('DOMSnapshot.captureSnapshot', {
          computedStyles: [],
        }),
        this.#connection.sendCommand('Page.getLayoutMetrics'),
      ])
      const document = cdpDocumentSchema.parse(documentResult)
      const domSnapshot = cdpDomSnapshotSchema.parse(domSnapshotResult)
      const layoutMetrics = cdpLayoutMetricsSchema.parse(layoutMetricsResult)
      const frameTree = collectFrameIds(frameTreeResult)
      const mainFrameId = document.root.frameId ?? frameTree.frameIds[0]
      if (!mainFrameId)
        throw new SemanticBrowserDriverError()
      const observedFrameIds = [
        mainFrameId,
        ...frameTree.frameIds.filter(frameId => frameId !== mainFrameId),
      ].slice(0, MAX_OBSERVED_FRAMES)
      const accessibilityResults = await Promise.allSettled(observedFrameIds.map(async (frameId) => {
        const result = await this.#connection.sendCommand(
          'Accessibility.getFullAXTree',
          { frameId },
        )
        return scopeAccessibilityNodes(
          cdpAxTreeSchema.parse(result).nodes,
          frameId,
        )
      }))
      const mainFrameAccessibility = accessibilityResults[0]
      if (!mainFrameAccessibility || mainFrameAccessibility.status === 'rejected')
        throw new SemanticBrowserDriverError()
      const unavailableFrameCount = accessibilityResults.filter(
        result => result.status === 'rejected',
      ).length
      const accessibilityNodes = deduplicateAccessibilityNodes(
        accessibilityResults.flatMap(result => (
          result.status === 'fulfilled' ? result.value : []
        )),
      )
      const { cssVisualViewport } = layoutMetrics
      const viewportNodeIds = collectViewportNodeIds(
        domSnapshot,
        mainFrameId,
        {
          height: cssVisualViewport.clientHeight,
          width: cssVisualViewport.clientWidth,
          x: cssVisualViewport.pageX,
          y: cssVisualViewport.pageY,
        },
      )
      const fieldMetadata = collectDomFieldMetadata(domSnapshot)

      const observationHeader: BrowserObservationHeader = {
        documentRevision: this.#documentRevision,
        observationId: this.#createId(),
        pageId: input.pageId,
        sessionId: input.sessionId,
        status: input.status,
        title: input.title.slice(0, 512),
        url: redactBrowserRuntimeUrl(input.url),
      }
      const maxElements = normalizeElementLimit(input.maxElements)
      const projected = projectElements(
        accessibilityNodes,
        mainFrameId,
        maxElements,
        observationHeader,
        viewportNodeIds,
        fieldMetadata,
      )
      const truncationReasons = new Set<BrowserObservationTruncation['reasons'][number]>()
      if (
        frameTree.truncated
        || frameTree.frameIds.some(frameId => !observedFrameIds.includes(frameId))
      ) {
        truncationReasons.add('frame-limit')
      }
      if (unavailableFrameCount > 0)
        truncationReasons.add('frame-unavailable')
      if (projected.truncationReason)
        truncationReasons.add(projected.truncationReason)

      const visualContent = hasVisualContent(domSnapshot, accessibilityNodes)
      const screenshotAllowed = !projected.containsSensitiveInputs
        && !containsSensitiveFieldMetadata(fieldMetadata)
      let screenshotReasons = screenshotAllowed
        ? getScreenshotFallbackReasons(
            truncationReasons.size > 0,
            projected.elements.length === 0,
            visualContent,
          )
        : []
      let screenshot = screenshotReasons.length > 0
        ? await this.#captureScreenshot()
        : undefined
      let observation: BrowserObservation

      while (true) {
        const truncation = createTruncation(
          truncationReasons,
          maxElements,
        )
        const screenshotRef = screenshot
          ? createScreenshotRef(screenshot, screenshotReasons)
          : undefined
        const candidate = {
          ...observationHeader,
          elements: projected.elements,
          ...(screenshotRef ? { screenshot: screenshotRef } : {}),
          truncated: Boolean(truncation),
          ...(truncation ? { truncation } : {}),
        }
        if (
          getBrowserObservationTextByteLength(candidate)
          <= BROWSER_MAX_OBSERVATION_TEXT_BYTES
        ) {
          observation = browserObservationSchema.parse(candidate)
          break
        }

        truncationReasons.add('text-limit')
        if (screenshotAllowed) {
          screenshotReasons = getScreenshotFallbackReasons(
            true,
            projected.elements.length === 0,
            visualContent,
          )
          screenshot ??= await this.#captureScreenshot()
        }
        const removed = projected.elements.pop()
        if (!removed)
          throw new SemanticBrowserDriverError()
        projected.targets.delete(removed.ref)
      }

      this.#storeObservation(
        observation.observationId,
        projected.targets,
        screenshot && observation.screenshot
          ? {
              bytes: screenshot.bytes,
              ref: observation.screenshot,
            }
          : undefined,
      )
      return observation
    }
    catch (error) {
      if (error instanceof SemanticBrowserDriverError)
        throw error
      throw new SemanticBrowserDriverError()
    }
  }

  async executeAction(input: SemanticBrowserActionInput): Promise<void> {
    try {
      const target = this.validateAction(input)
      this.#ensureDebugger()
      if (!target) {
        if (input.action.kind === 'press') {
          await this.#press(input.action.key)
          return
        }
        if (input.action.kind === 'scroll') {
          await this.#scrollPage(input.action.direction, input.action.amount)
          return
        }
        throw new SemanticBrowserDriverError()
      }

      await this.#withLiveTarget(target, input.action, async (objectId) => {
        switch (input.action.kind) {
          case 'click':
            await this.#click(target)
            return
          case 'fill':
            await this.#focus(target)
            await this.#selectAllAndDelete()
            if (input.action.text)
              await this.#insertText(input.action.text)
            return
          case 'type':
            await this.#focus(target)
            await this.#insertText(input.action.text)
            return
          case 'press':
            await this.#focus(target)
            await this.#press(input.action.key)
            return
          case 'select':
            await this.#select(objectId, input.action.values)
            return
          case 'scroll':
            await this.#scrollTarget(
              objectId,
              input.action.direction,
              input.action.amount,
            )
            return
          default:
            throw new SemanticBrowserDriverError()
        }
      })
    }
    catch (error) {
      if (error instanceof SemanticBrowserDriverError)
        throw error
      throw new SemanticBrowserDriverError()
    }
  }

  validateAction(input: SemanticBrowserActionInput): SemanticBrowserTarget | null {
    this.#assertActive()
    const reference = {
      documentRevision: input.documentRevision,
      observationId: input.observationId,
    }
    const ref = getBrowserActionRef(input.action)
    if (!ref) {
      this.assertObservation(reference)
      if (input.frameId)
        throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
      if (
        input.action.kind === 'press'
        && this.#observations.get(input.observationId)?.requiresHumanInput
      ) {
        throw new SemanticBrowserDriverError('BROWSER_HUMAN_INPUT_REQUIRED')
      }
      return null
    }

    const target = this.resolveTarget({ ...reference, ref })
    if (target.frameId !== input.frameId)
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    if (
      target.inputMode === 'human'
      && input.action.kind !== 'scroll'
      && input.action.kind !== 'wait'
    ) {
      throw new SemanticBrowserDriverError('BROWSER_HUMAN_INPUT_REQUIRED')
    }
    if (!supportsTargetAction(target, input.action))
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    return target
  }

  assertObservation(reference: {
    documentRevision: number
    observationId: string
  }): void {
    this.#assertActive()
    this.#pruneObservations(this.#now())
    const observation = this.#observations.get(reference.observationId)
    if (
      reference.documentRevision !== this.#documentRevision
      || observation?.documentRevision !== reference.documentRevision
    ) {
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    }
  }

  resolveTarget(reference: SemanticBrowserTargetReference): SemanticBrowserTarget {
    this.assertObservation(reference)
    const observation = this.#observations.get(reference.observationId)
    const target = observation?.targets.get(reference.ref)
    if (
      !target
    ) {
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    }
    return { ...target, actions: [...target.actions] }
  }

  resolveScreenshot(
    reference: SemanticBrowserScreenshotReference,
  ): SemanticBrowserScreenshot {
    this.#assertActive()
    this.#pruneObservations(this.#now())
    const observation = this.#observations.get(reference.observationId)
    const screenshot = observation?.screenshot
    if (
      reference.documentRevision !== this.#documentRevision
      || observation?.documentRevision !== reference.documentRevision
      || screenshot?.ref.screenshotId !== reference.screenshotId
    ) {
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    }
    return {
      bytes: screenshot.bytes.slice(),
      mimeType: 'image/png',
    }
  }

  invalidateDocument(): void {
    this.#assertActive()
    if (this.#documentRevision >= Number.MAX_SAFE_INTEGER)
      throw new SemanticBrowserDriverError()
    this.#documentRevision += 1
    this.#clearObservations()
  }

  async isTextVisible(text: string): Promise<boolean> {
    const snapshot = await this.#captureDomSnapshot()
    const needle = normalizeWaitText(text)
    if (!needle)
      return false
    for (const document of snapshot.documents) {
      const layoutText = document.layout.text
      if (!layoutText)
        continue
      for (const index of layoutText) {
        const value = snapshot.strings[index]
        if (value && normalizeWaitText(value).includes(needle))
          return true
      }
    }
    return false
  }

  async isTargetVisible(reference: SemanticBrowserTargetReference): Promise<boolean> {
    const target = this.resolveTarget(reference)
    this.#ensureDebugger()
    let objectId: string
    try {
      const resolved = cdpResolveNodeSchema.parse(
        await this.#connection.sendCommand('DOM.resolveNode', {
          backendNodeId: target.backendDOMNodeId,
          objectGroup: BROWSER_ACTION_OBJECT_GROUP,
        }),
      )
      objectId = resolved.object.objectId
    }
    catch {
      return false
    }
    try {
      const { model } = cdpBoxModelSchema.parse(
        await this.#connection.sendCommand('DOM.getBoxModel', {
          backendNodeId: target.backendDOMNodeId,
        }),
      )
      const { height, width } = quadSize(model.border)
      return width > 0 && height > 0
    }
    catch {
      return false
    }
    finally {
      await this.#connection.sendCommand(
        'Runtime.releaseObject',
        { objectId },
      ).catch(() => {})
    }
  }

  async fingerprintDocument(): Promise<string> {
    const snapshot = await this.#captureDomSnapshot()
    let nodeCount = 0
    let layoutCount = 0
    let textLength = 0
    for (const document of snapshot.documents) {
      nodeCount += document.nodes.backendNodeId.length
      layoutCount += document.layout.nodeIndex.length
      for (const index of document.layout.text ?? [])
        textLength += snapshot.strings[index]?.length ?? 0
    }
    return `${nodeCount}:${layoutCount}:${textLength}`
  }

  async #captureDomSnapshot(): Promise<z.infer<typeof cdpDomSnapshotSchema>> {
    this.#assertActive()
    this.#ensureDebugger()
    try {
      return cdpDomSnapshotSchema.parse(
        await this.#connection.sendCommand('DOMSnapshot.captureSnapshot', {
          computedStyles: [],
        }),
      )
    }
    catch {
      throw new SemanticBrowserDriverError()
    }
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    this.#clearObservations()
    if (this.#ownsConnection)
      this.#connection.dispose()
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new SemanticBrowserDriverError()
  }

  async #withLiveTarget(
    target: SemanticBrowserTarget,
    action: BrowserAction,
    operation: (objectId: string) => Promise<void>,
  ): Promise<void> {
    let objectId: string
    try {
      const resolved = cdpResolveNodeSchema.parse(
        await this.#connection.sendCommand('DOM.resolveNode', {
          backendNodeId: target.backendDOMNodeId,
          objectGroup: BROWSER_ACTION_OBJECT_GROUP,
        }),
      )
      objectId = resolved.object.objectId
    }
    catch (error) {
      if (error instanceof SemanticBrowserDriverError)
        throw error
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    }

    try {
      if (action.kind === 'click') {
        await this.#connection.sendCommand('DOM.scrollIntoViewIfNeeded', {
          backendNodeId: target.backendDOMNodeId,
        })
      }
      let actionability: z.infer<typeof browserTargetActionabilitySchema>
      try {
        actionability = await this.#readActionability(objectId, action.kind === 'click')
      }
      catch {
        throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
      }
      const actionabilityFailure = getLiveTargetFailureReason(action, actionability)
      if (actionabilityFailure) {
        throw new SemanticBrowserDriverError(
          'BROWSER_TARGET_STALE',
          actionabilityFailure,
        )
      }
      if (requiresHumanInputAtActionTime(target, action, actionability))
        throw new SemanticBrowserDriverError('BROWSER_HUMAN_INPUT_REQUIRED')
      await operation(objectId)
    }
    finally {
      await this.#connection.sendCommand(
        'Runtime.releaseObject',
        { objectId },
      ).catch(() => {})
    }
  }

  async #readActionability(objectId: string, checkClickability: boolean) {
    const response = cdpRuntimeResultSchema.parse(
      await this.#connection.sendCommand('Runtime.callFunctionOn', {
        arguments: [{ value: checkClickability }],
        awaitPromise: true,
        functionDeclaration: BROWSER_TARGET_ACTIONABILITY_FUNCTION,
        objectId,
        returnByValue: true,
        silent: true,
      }),
    )
    if (response.exceptionDetails)
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
    return browserTargetActionabilitySchema.parse(response.result.value)
  }

  async #click(target: SemanticBrowserTarget): Promise<void> {
    const { model } = cdpBoxModelSchema.parse(
      await this.#connection.sendCommand('DOM.getBoxModel', {
        backendNodeId: target.backendDOMNodeId,
      }),
    )
    const { x, y } = quadCenter(model.content)
    await this.#connection.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    })
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.#connection.sendCommand('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type,
        x,
        y,
      })
    }
  }

  async #focus(target: SemanticBrowserTarget): Promise<void> {
    await this.#connection.sendCommand('DOM.focus', {
      backendNodeId: target.backendDOMNodeId,
    })
  }

  async #insertText(text: string): Promise<void> {
    await this.#connection.sendCommand('Input.insertText', { text })
  }

  async #selectAllAndDelete(): Promise<void> {
    const modifier = platform === OPERATING_SYSTEM.MacOS ? 4 : 2
    await this.#dispatchKey({ code: 'KeyA', key: 'a', modifiers: modifier })
    await this.#dispatchKey({ code: 'Backspace', key: 'Backspace' })
  }

  async #press(key: Extract<BrowserAction, { kind: 'press' }>['key']): Promise<void> {
    const definition = browserKeyDefinition(key)
    await this.#dispatchKey(definition)
  }

  async #dispatchKey(input: {
    code: string
    key: string
    modifiers?: number
    text?: string
    windowsVirtualKeyCode?: number
  }): Promise<void> {
    await this.#connection.sendCommand('Input.dispatchKeyEvent', {
      ...input,
      type: input.text ? 'keyDown' : 'rawKeyDown',
    })
    await this.#connection.sendCommand('Input.dispatchKeyEvent', {
      code: input.code,
      key: input.key,
      modifiers: input.modifiers,
      type: 'keyUp',
      windowsVirtualKeyCode: input.windowsVirtualKeyCode,
    })
  }

  async #select(objectId: string, values: string[]): Promise<void> {
    const response = cdpRuntimeResultSchema.parse(
      await this.#connection.sendCommand('Runtime.callFunctionOn', {
        arguments: [{ value: values }],
        functionDeclaration: BROWSER_SELECT_FUNCTION,
        objectId,
        returnByValue: true,
        silent: true,
      }),
    )
    if (response.exceptionDetails || response.result.value !== true)
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
  }

  async #scrollTarget(
    objectId: string,
    direction: Extract<BrowserAction, { kind: 'scroll' }>['direction'],
    amount: Extract<BrowserAction, { kind: 'scroll' }>['amount'],
  ): Promise<void> {
    const response = cdpRuntimeResultSchema.parse(
      await this.#connection.sendCommand('Runtime.callFunctionOn', {
        arguments: [{ value: direction }, { value: amount }],
        functionDeclaration: BROWSER_SCROLL_TARGET_FUNCTION,
        objectId,
        returnByValue: true,
        silent: true,
      }),
    )
    if (response.exceptionDetails || response.result.value !== true)
      throw new SemanticBrowserDriverError('BROWSER_TARGET_STALE')
  }

  async #scrollPage(
    direction: Extract<BrowserAction, { kind: 'scroll' }>['direction'],
    amount: Extract<BrowserAction, { kind: 'scroll' }>['amount'],
  ): Promise<void> {
    const { cssVisualViewport } = cdpLayoutMetricsSchema.parse(
      await this.#connection.sendCommand('Page.getLayoutMetrics'),
    )
    await this.#connection.sendCommand('Input.dispatchMouseEvent', {
      deltaX: 0,
      deltaY: (direction === 'down' ? 1 : -1)
        * cssVisualViewport.clientHeight
        * (amount === 'page' ? 1 : 0.5),
      type: 'mouseWheel',
      x: cssVisualViewport.clientWidth / 2,
      y: cssVisualViewport.clientHeight / 2,
    })
  }

  #ensureDebugger(): void {
    this.#connection.ensureAttached()
  }

  async #captureScreenshot(): Promise<{
    bytes: Uint8Array
    height: number
    screenshotId: string
    width: number
  }> {
    const image = await this.#page.capturePage()
    const { height, width } = image.getSize()
    const bytes = Uint8Array.from(image.toPNG())
    if (
      !Number.isInteger(height)
      || !Number.isInteger(width)
      || height < 1
      || height > 32_768
      || width < 1
      || width > 32_768
      || bytes.byteLength < 8
      || bytes.byteLength > BROWSER_MAX_SCREENSHOT_BYTES
      || !hasPngSignature(bytes)
    ) {
      throw new SemanticBrowserDriverError()
    }
    return {
      bytes,
      height,
      screenshotId: this.#createScreenshotId(),
      width,
    }
  }

  #pruneObservations(now: number): void {
    for (const [observationId, observation] of this.#observations) {
      if (
        observation.expiresAt <= now
        || observation.documentRevision !== this.#documentRevision
      ) {
        this.#observations.delete(observationId)
      }
    }
  }

  #clearObservations(): void {
    if (this.#observationExpiryTimer)
      clearTimeout(this.#observationExpiryTimer)
    this.#observationExpiryTimer = null
    this.#observations.clear()
  }

  #scheduleObservationExpiry(): void {
    if (this.#observationExpiryTimer)
      clearTimeout(this.#observationExpiryTimer)
    this.#observationExpiryTimer = null
    if (!this.#observations.size)
      return
    const expiresAt = Math.min(...[...this.#observations.values()].map(observation => observation.expiresAt))
    this.#observationExpiryTimer = setTimeout(() => {
      this.#observationExpiryTimer = null
      this.#pruneObservations(this.#now())
      this.#scheduleObservationExpiry()
    }, Math.max(1, expiresAt - this.#now()))
    this.#observationExpiryTimer.unref()
  }

  #storeObservation(
    observationId: string,
    targets: Map<string, SemanticBrowserTarget>,
    screenshot?: StoredObservation['screenshot'],
  ): void {
    this.#assertActive()
    const now = this.#now()
    this.#pruneObservations(now)
    this.#observations.delete(observationId)
    this.#observations.set(observationId, {
      documentRevision: this.#documentRevision,
      expiresAt: now + this.#observationTtlMs,
      requiresHumanInput: [...targets.values()].some(
        target => target.inputMode === 'human',
      ),
      ...(screenshot ? { screenshot } : {}),
      targets,
    })
    let screenshotBytes = [...this.#observations.values()].reduce((total, observation) => total + (observation.screenshot?.bytes.byteLength ?? 0), 0)
    while (this.#observations.size > this.#maxObservations || screenshotBytes > MAX_SCREENSHOT_CACHE_BYTES) {
      const oldestObservationId = this.#observations.keys().next().value
      if (oldestObservationId === undefined)
        break
      screenshotBytes -= this.#observations.get(oldestObservationId)?.screenshot?.bytes.byteLength ?? 0
      this.#observations.delete(oldestObservationId)
    }
    this.#scheduleObservationExpiry()
  }
}

function supportsTargetAction(
  target: SemanticBrowserTarget,
  action: BrowserAction,
): boolean {
  switch (action.kind) {
    case 'click':
    case 'fill':
    case 'type':
    case 'select':
      return target.actions.includes(action.kind)
    case 'press':
      return target.actions.length > 0
    case 'scroll':
    case 'wait':
      return true
    default:
      return false
  }
}

function requiresHumanInputAtActionTime(
  target: SemanticBrowserTarget,
  action: BrowserAction,
  actionability: z.infer<typeof browserTargetActionabilitySchema>,
): boolean {
  if (action.kind === 'scroll')
    return false
  const { fieldMetadata } = actionability
  const attributes = new Map([
    ['aria-label', fieldMetadata.ariaLabel],
    ['autocomplete', fieldMetadata.autocomplete],
    ['id', fieldMetadata.id],
    ['label', fieldMetadata.label],
    ['name', fieldMetadata.name],
    ['placeholder', fieldMetadata.placeholder],
    ['type', fieldMetadata.type],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])))
  return projectBrowserObservedValue({
    attributes,
    description: target.description ?? '',
    hasValue: false,
    name: target.name,
    protectedField: false,
    role: target.role,
    value: undefined,
  }).inputMode === 'human'
}

function getLiveTargetFailureReason(
  action: BrowserAction,
  target: z.infer<typeof browserTargetActionabilitySchema>,
): BrowserFailureReason | null {
  if (!target.connected)
    return 'TARGET_DETACHED'
  if (action.kind !== 'scroll' && !target.visible)
    return 'TARGET_NOT_VISIBLE'
  if (action.kind !== 'scroll' && target.disabled)
    return 'TARGET_DISABLED'
  switch (action.kind) {
    case 'click':
      if (!target.stable)
        return 'TARGET_UNSTABLE'
      return target.covered ? 'TARGET_COVERED' : null
    case 'fill':
    case 'type':
      if (target.readOnly)
        return 'TARGET_READ_ONLY'
      return target.editable ? null : 'TARGET_NOT_EDITABLE'
    case 'press':
      return target.focusable ? null : 'TARGET_NOT_FOCUSABLE'
    case 'select':
      return target.selectable ? null : 'TARGET_NOT_SELECTABLE'
    case 'scroll':
      return null
    default:
      return 'INVALID_TARGET'
  }
}

function quadCenter(quad: number[]): { x: number, y: number } {
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  }
}

function quadSize(quad: number[]): { height: number, width: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  return {
    height: Math.max(...ys) - Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
  }
}

function normalizeWaitText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function browserKeyDefinition(
  key: Extract<BrowserAction, { kind: 'press' }>['key'],
): {
  code: string
  key: string
  text?: string
  windowsVirtualKeyCode: number
} {
  const definitions = {
    ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
    ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
    Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 },
    End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
    Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
    Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
    Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
    PageDown: { code: 'PageDown', key: 'PageDown', windowsVirtualKeyCode: 34 },
    PageUp: { code: 'PageUp', key: 'PageUp', windowsVirtualKeyCode: 33 },
    Space: { code: 'Space', key: ' ', text: ' ', windowsVirtualKeyCode: 32 },
    Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
  } satisfies Record<typeof key, {
    code: string
    key: string
    text?: string
    windowsVirtualKeyCode: number
  }>
  return definitions[key]
}
