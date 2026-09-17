import type { z } from 'zod'
import type { BrowserObservation, BrowserObservationTruncation, BrowserObservedElement, BrowserScreenshotRef } from '../../../shared/browser'
import type { CdpAxNode, CdpAxProperty, cdpDomSnapshotSchema } from './browserCdpSchemas'
import { BROWSER_DEFAULT_OBSERVATION_ELEMENT_LIMIT, BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT, BROWSER_MAX_OBSERVATION_TEXT_BYTES, getBrowserObservationTextByteLength } from '../../../shared/browser'
import { cdpFrameTreeNodeSchema, cdpFrameTreeSchema } from './browserCdpSchemas'
import { isBrowserValueRole, projectBrowserObservedValue } from './browserPrivacy'

export type BrowserObservationHeader = Omit<
  BrowserObservation,
  'elements' | 'screenshot' | 'truncated' | 'truncation'
>
export type ProjectedElement = Omit<BrowserObservedElement, 'ref'>

export interface SemanticBrowserTarget {
  readonly actions: readonly string[]
  readonly backendDOMNodeId: number
  readonly description?: string
  readonly frameId: string
  readonly inputMode?: 'human'
  readonly name: string
  readonly role: string
}

type DomFieldMetadata = ReadonlyMap<string, string>

export const MAX_OBSERVED_FRAMES = 32

interface ProjectedNode {
  backendDOMNodeId: number
  element: ProjectedElement
  focused: boolean
  inViewport: boolean
}

interface ViewportBounds {
  height: number
  width: number
  x: number
  y: number
}

const SKIPPED_ROLES = new Set([
  'document',
  'inline-text-box',
  'none',
  'presentation',
])

const CLICK_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menu-item',
  'menu-item-checkbox',
  'menu-item-radio',
  'option',
  'radio',
  'switch',
  'tab',
  'tree-item',
])

const INTERACTIVE_ROLES = new Set([
  ...CLICK_ROLES,
  'combo-box',
  'list-box',
  'search-box',
  'slider',
  'spin-button',
  'textbox',
])

const STATUS_ROLES = new Set([
  'alert',
  'alert-dialog',
  'log',
  'meter',
  'progress-bar',
  'status',
  'timer',
])

const FIELD_METADATA_ATTRIBUTES = new Set([
  'aria-label',
  'autocomplete',
  'id',
  'name',
  'placeholder',
  'type',
])

const INTERNAL_VALUE_DESCENDANT_ROLES = new Set([
  'search-box',
  'spin-button',
  'textbox',
])

export function collectFrameIds(input: unknown): {
  frameIds: string[]
  truncated: boolean
} {
  const response = cdpFrameTreeSchema.parse(input)
  const frameIds: string[] = []
  const seen = new Set<string>()
  const pending: unknown[] = [response.frameTree]

  while (pending.length > 0 && frameIds.length <= MAX_OBSERVED_FRAMES) {
    const frameTree = cdpFrameTreeNodeSchema.parse(pending.shift())
    if (!seen.has(frameTree.frame.id)) {
      seen.add(frameTree.frame.id)
      frameIds.push(frameTree.frame.id)
    }
    if (frameTree.childFrames)
      pending.unshift(...frameTree.childFrames)
  }

  return {
    frameIds: frameIds.slice(0, MAX_OBSERVED_FRAMES),
    truncated: frameIds.length > MAX_OBSERVED_FRAMES || pending.length > 0,
  }
}

export function scopeAccessibilityNodes(
  nodes: CdpAxNode[],
  requestedFrameId: string,
): CdpAxNode[] {
  const nodesById = new Map(nodes.map(node => [node.nodeId, node] as const))
  const resolvedFrameIds = new Map<string, string>()
  const resolving = new Set<string>()
  const resolveFrameId = (node: CdpAxNode): string => {
    const cached = resolvedFrameIds.get(node.nodeId)
    if (cached)
      return cached
    if (node.frameId) {
      resolvedFrameIds.set(node.nodeId, node.frameId)
      return node.frameId
    }
    if (resolving.has(node.nodeId))
      return requestedFrameId

    resolving.add(node.nodeId)
    const parent = node.parentId ? nodesById.get(node.parentId) : undefined
    const frameId = parent ? resolveFrameId(parent) : requestedFrameId
    resolving.delete(node.nodeId)
    resolvedFrameIds.set(node.nodeId, frameId)
    return frameId
  }

  return nodes.map(node => ({
    ...node,
    frameId: resolveFrameId(node),
  }))
}

export function deduplicateAccessibilityNodes(nodes: CdpAxNode[]): CdpAxNode[] {
  const seen = new Set<string>()
  return nodes.filter((node) => {
    const identity = node.backendDOMNodeId
      ? `backend:${node.frameId ?? ''}:${node.backendDOMNodeId}`
      : `ax:${node.frameId ?? ''}:${node.nodeId}`
    if (seen.has(identity))
      return false
    seen.add(identity)
    return true
  })
}

export function createTruncation(
  reasons: ReadonlySet<BrowserObservationTruncation['reasons'][number]>,
  maxElements: number,
): BrowserObservationTruncation | undefined {
  const orderedReasons = [
    'element-limit',
    'frame-limit',
    'frame-unavailable',
    'text-limit',
  ].filter((reason): reason is BrowserObservationTruncation['reasons'][number] => (
    reasons.has(reason as BrowserObservationTruncation['reasons'][number])
  ))
  if (orderedReasons.length === 0)
    return undefined
  if (
    orderedReasons.length === 1
    && orderedReasons[0] === 'element-limit'
    && maxElements < BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT
  ) {
    return {
      reasons: orderedReasons,
      suggestedMaxElements: Math.min(
        BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT,
        Math.max(maxElements + 1, maxElements * 2),
      ),
    }
  }
  return { reasons: orderedReasons }
}

export function getScreenshotFallbackReasons(
  truncated: boolean,
  empty: boolean,
  visualContent: boolean,
): BrowserScreenshotRef['reasons'] {
  const reasons: BrowserScreenshotRef['reasons'] = []
  if (empty)
    reasons.push('semantic-content-empty')
  if (truncated)
    reasons.push('semantic-content-truncated')
  if (visualContent)
    reasons.push('visual-content')
  return reasons
}

export function createScreenshotRef(
  screenshot: {
    bytes: Uint8Array
    height: number
    screenshotId: string
    width: number
  },
  reasons: BrowserScreenshotRef['reasons'],
): BrowserScreenshotRef {
  return {
    byteLength: screenshot.bytes.byteLength,
    height: screenshot.height,
    mimeType: 'image/png',
    reasons: [...reasons],
    screenshotId: screenshot.screenshotId,
    width: screenshot.width,
  }
}

export function hasVisualContent(
  snapshot: z.infer<typeof cdpDomSnapshotSchema>,
  nodes: CdpAxNode[],
): boolean {
  for (const document of snapshot.documents) {
    for (const nodeNameIndex of document.nodes.nodeName ?? []) {
      if (snapshot.strings[nodeNameIndex]?.toLowerCase() === 'canvas')
        return true
    }
  }

  const meaningfulNodes = nodes.filter(node => !node.ignored && node.backendDOMNodeId)
  const visualNodeCount = meaningfulNodes.filter((node) => {
    const role = normalizeRole(readAxString(node.role))
    return role === 'canvas'
      || role === 'figure'
      || role === 'graphics-document'
      || role === 'graphics-object'
      || role === 'image'
  }).length
  return visualNodeCount > 0 && visualNodeCount * 2 >= meaningfulNodes.length
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  return signature.every((byte, index) => bytes[index] === byte)
}

export function normalizeElementLimit(maxElements: number | undefined): number {
  if (maxElements === undefined)
    return BROWSER_DEFAULT_OBSERVATION_ELEMENT_LIMIT
  if (!Number.isInteger(maxElements) || maxElements < 1)
    throw new RangeError('Browser observation element limit must be a positive integer')
  return Math.min(maxElements, BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT)
}

export function projectElements(
  nodes: CdpAxNode[],
  mainFrameId: string,
  maxElements: number,
  observationHeader: BrowserObservationHeader,
  viewportNodeIds: ReadonlySet<number>,
  fieldMetadata: ReadonlyMap<number, DomFieldMetadata>,
): {
  containsSensitiveInputs: boolean
  elements: BrowserObservedElement[]
  targets: Map<string, SemanticBrowserTarget>
  truncationReason: 'element-limit' | 'text-limit' | null
} {
  const elements: BrowserObservedElement[] = []
  const targets = new Map<string, SemanticBrowserTarget>()
  const valueControlDescendants = collectValueControlDescendants(
    nodes,
    fieldMetadata,
  )
  const projectedNodes = nodes
    .filter(node => !valueControlDescendants.has(getAxNodeKey(node)))
    .map(node => projectElement(
      node,
      mainFrameId,
      viewportNodeIds,
      fieldMetadata.get(node.backendDOMNodeId ?? 0),
    ))
    .filter((node): node is ProjectedNode => node !== null)
  const containsSensitiveInputs = projectedNodes.some(
    node => node.element.inputMode === 'human',
  )
  const focusedIndex = projectedNodes.findIndex(node => node.focused)
  const rankedNodes = projectedNodes
    .map((node, index) => ({
      index,
      node,
      priority: getRelevancePriority(node, index, focusedIndex),
    }))
    .sort((left, right) => (
      right.priority - left.priority
      || left.index - right.index
    ))

  for (const { node: projected } of rankedNodes) {
    if (elements.length === maxElements) {
      return {
        containsSensitiveInputs,
        elements,
        targets,
        truncationReason: 'element-limit',
      }
    }
    const ref = `e${elements.length + 1}`
    const element = { ...projected.element, ref }
    if (
      getBrowserObservationTextByteLength({
        ...observationHeader,
        elements: [...elements, element],
        truncated: false,
      }) > BROWSER_MAX_OBSERVATION_TEXT_BYTES
    ) {
      return {
        containsSensitiveInputs,
        elements,
        targets,
        truncationReason: 'text-limit',
      }
    }
    elements.push(element)
    targets.set(ref, {
      actions: [...projected.element.actions],
      backendDOMNodeId: projected.backendDOMNodeId,
      ...(projected.element.description ? { description: projected.element.description } : {}),
      frameId: projected.element.frameId,
      ...(projected.element.inputMode ? { inputMode: projected.element.inputMode } : {}),
      name: projected.element.name,
      role: projected.element.role,
    })
  }
  return {
    containsSensitiveInputs,
    elements,
    targets,
    truncationReason: null,
  }
}

export function projectElement(
  node: CdpAxNode,
  mainFrameId: string,
  viewportNodeIds: ReadonlySet<number>,
  fieldMetadata: DomFieldMetadata | undefined,
): ProjectedNode | null {
  if (node.ignored || !node.backendDOMNodeId)
    return null
  const role = normalizeRole(readAxString(node.role))
  if (!role || SKIPPED_ROLES.has(role))
    return null

  const properties = new Map(
    (node.properties ?? []).map(property => [property.name, property] as const),
  )
  const name = normalizeText(readAxString(node.name), 1_024)
  const description = normalizeText(readAxString(node.description), 1_024)
  const states = projectStates(properties)
  const observedValue = projectBrowserObservedValue({
    attributes: fieldMetadata,
    description,
    hasValue: node.value !== undefined,
    name,
    protectedField: readAxBooleanish(properties.get('protected')),
    role,
    value: node.value?.value,
  })
  const actions = observedValue.inputMode === 'human'
    ? []
    : projectActions(role, properties)
  if (
    !name
    && !description
    && actions.length === 0
    && states.length === 0
    && observedValue.valueState === undefined
  ) {
    return null
  }

  const level = readPositiveInteger(properties.get('level'))
  return {
    backendDOMNodeId: node.backendDOMNodeId,
    element: {
      actions,
      ...(description ? { description } : {}),
      frameId: node.frameId ?? mainFrameId,
      ...(level ? { level } : {}),
      name,
      role,
      states,
      ...observedValue,
    },
    focused: readAxBoolean(properties.get('focused')),
    inViewport: viewportNodeIds.has(node.backendDOMNodeId),
  }
}

export function collectValueControlDescendants(
  nodes: CdpAxNode[],
  fieldMetadata: ReadonlyMap<number, DomFieldMetadata>,
): Set<string> {
  const nodesById = new Map(nodes.map(node => [getAxNodeKey(node), node] as const))
  const valueControlIds = new Set(nodes.flatMap((node) => {
    const role = normalizeRole(readAxString(node.role))
    if (node.ignored || !isBrowserValueRole(role))
      return []
    if (INTERNAL_VALUE_DESCENDANT_ROLES.has(role))
      return [getAxNodeKey(node)]
    const properties = new Map(
      (node.properties ?? []).map(property => [property.name, property] as const),
    )
    const projection = projectBrowserObservedValue({
      attributes: fieldMetadata.get(node.backendDOMNodeId ?? 0),
      description: normalizeText(readAxString(node.description), 1_024),
      hasValue: node.value !== undefined,
      name: normalizeText(readAxString(node.name), 1_024),
      protectedField: readAxBooleanish(properties.get('protected')),
      role,
      value: node.value?.value,
    })
    return projection.inputMode === 'human' ? [getAxNodeKey(node)] : []
  }))
  const descendants = new Set<string>()

  for (const node of nodes) {
    const frameId = node.frameId ?? ''
    const visited = new Set([getAxNodeKey(node)])
    let parentId = node.parentId
    while (parentId) {
      const parentKey = `${frameId}\0${parentId}`
      if (visited.has(parentKey))
        break
      if (valueControlIds.has(parentKey)) {
        descendants.add(getAxNodeKey(node))
        break
      }
      visited.add(parentKey)
      parentId = nodesById.get(parentKey)?.parentId
    }
  }
  return descendants
}

export function getAxNodeKey(node: CdpAxNode): string {
  return `${node.frameId ?? ''}\0${node.nodeId}`
}

export function getRelevancePriority(
  node: ProjectedNode,
  index: number,
  focusedIndex: number,
): number {
  if (node.focused)
    return 5
  if (
    INTERACTIVE_ROLES.has(node.element.role)
    || node.element.actions.length > 0
  ) {
    return 4
  }
  if (
    STATUS_ROLES.has(node.element.role)
    || node.element.states.includes('busy')
    || node.element.states.includes('invalid')
  ) {
    return 3
  }
  if (node.element.role === 'heading')
    return 2
  if (focusedIndex >= 0 && Math.abs(index - focusedIndex) === 1)
    return 1
  if (node.inViewport)
    return 1
  return 0
}

export function collectDomFieldMetadata(
  snapshot: z.infer<typeof cdpDomSnapshotSchema>,
): Map<number, DomFieldMetadata> {
  const metadata = new Map<number, DomFieldMetadata>()
  for (const document of snapshot.documents) {
    for (let nodeIndex = 0; nodeIndex < document.nodes.backendNodeId.length; nodeIndex += 1) {
      const backendNodeId = document.nodes.backendNodeId[nodeIndex]
      const attributeIndexes = document.nodes.attributes?.[nodeIndex]
      if (!backendNodeId || !attributeIndexes)
        continue
      const attributes = new Map<string, string>()
      for (let index = 0; index + 1 < attributeIndexes.length; index += 2) {
        const name = snapshot.strings[attributeIndexes[index]]?.toLowerCase()
        const value = snapshot.strings[attributeIndexes[index + 1]]
        if (name && value !== undefined && FIELD_METADATA_ATTRIBUTES.has(name))
          attributes.set(name, value)
      }
      if (attributes.size > 0)
        metadata.set(backendNodeId, attributes)
    }
  }
  return metadata
}

export function containsSensitiveFieldMetadata(
  metadata: ReadonlyMap<number, DomFieldMetadata>,
): boolean {
  return [...metadata.values()].some(attributes => (
    projectBrowserObservedValue({
      attributes,
      description: '',
      hasValue: false,
      name: '',
      protectedField: false,
      role: 'textbox',
      value: undefined,
    }).inputMode === 'human'
  ))
}

export function collectViewportNodeIds(
  snapshot: z.infer<typeof cdpDomSnapshotSchema>,
  mainFrameId: string,
  viewport: ViewportBounds,
): Set<number> {
  const document = snapshot.documents.find(candidate => (
    snapshot.strings[candidate.frameId] === mainFrameId
  ))
  const nodeIds = new Set<number>()
  if (!document)
    return nodeIds

  const layoutLength = Math.min(
    document.layout.bounds.length,
    document.layout.nodeIndex.length,
  )
  for (let index = 0; index < layoutLength; index += 1) {
    const nodeIndex = document.layout.nodeIndex[index]
    const backendNodeId = document.nodes.backendNodeId[nodeIndex]
    const bounds = document.layout.bounds[index]
    if (
      backendNodeId
      && bounds
      && intersectsViewport(bounds, viewport)
    ) {
      nodeIds.add(backendNodeId)
    }
  }
  return nodeIds
}

export function intersectsViewport(
  [x, y, width, height]: [number, number, number, number],
  viewport: ViewportBounds,
): boolean {
  return width > 0
    && height > 0
    && x < viewport.x + viewport.width
    && x + width > viewport.x
    && y < viewport.y + viewport.height
    && y + height > viewport.y
}

export function projectActions(
  role: string,
  properties: Map<string, CdpAxProperty>,
): string[] {
  if (readAxBoolean(properties.get('disabled')))
    return []
  if (role === 'textbox' || role === 'search-box')
    return ['fill', 'type']
  if (role === 'combo-box' || role === 'list-box')
    return ['select']
  return CLICK_ROLES.has(role) ? ['click'] : []
}

export function projectStates(properties: Map<string, CdpAxProperty>): string[] {
  const states: string[] = []
  for (const name of [
    'disabled',
    'focused',
    'focusable',
    'required',
    'readonly',
    'editable',
    'busy',
    'selected',
  ]) {
    if (readAxBooleanish(properties.get(name)))
      states.push(name)
  }

  const checked = readAxValue(properties.get('checked'))
  if (checked === true)
    states.push('checked')
  else if (checked === false)
    states.push('unchecked')
  else if (checked === 'mixed')
    states.push('mixed')

  const expanded = readAxValue(properties.get('expanded'))
  if (expanded === true)
    states.push('expanded')
  else if (expanded === false)
    states.push('collapsed')

  if (readAxBooleanish(properties.get('invalid')))
    states.push('invalid')
  return states
}

export function normalizeRole(rawRole: string): string {
  const role = rawRole
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
  if (role === 'root-web-area' || role === 'web-area')
    return 'document'
  if (role === 'static-text')
    return 'text'
  if (role === 'searchbox')
    return 'search-box'
  return role.slice(0, 256)
}

export function normalizeText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function readAxString(value: { value?: unknown } | undefined): string {
  return typeof value?.value === 'string' ? value.value : ''
}

export function readAxValue(property: CdpAxProperty | undefined): unknown {
  return property?.value.value
}

export function readAxBoolean(property: CdpAxProperty | undefined): boolean {
  return readAxValue(property) === true
}

export function readAxBooleanish(property: CdpAxProperty | undefined): boolean {
  const value = readAxValue(property)
  return value === true
    || (typeof value === 'string' && value !== '' && value !== 'false' && value !== 'none')
}

export function readPositiveInteger(property: CdpAxProperty | undefined): number | undefined {
  const value = readAxValue(property)
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 128
    ? Number(value)
    : undefined
}
