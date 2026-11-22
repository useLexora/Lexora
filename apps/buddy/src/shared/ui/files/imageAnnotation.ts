import type { SelectionReferenceRequest } from '@/shared/ui/selection/workbenchSelectionReferences'
import { getDirectSelectionReferenceTarget } from '@/shared/ui/selection/workbenchSelectionReferences'

export interface AnnotationPoint {
  x: number
  y: number
}

export interface ImageAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageBounds {
  width: number
  height: number
}

export interface ImageDisplayBox {
  left: number
  top: number
  width: number
  height: number
}

const ANNOTATION_PREVIEW_HOSTS = new Set(['media', 'grant-media', 'task-media'])

export function isStaticAnnotatableImageName(name: string): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(name.split(/[\\/]/).at(-1) ?? '')
}

export function annotatedSnapshotName(name: string): string {
  const suffix = '-annotated.png'
  const base = name.split(/[\\/]/).at(-1) ?? 'image'
  const stem = (base.replace(/\.(?:png|jpe?g|webp)$/i, '') || 'image').slice(0, 180 - suffix.length)
  return `${stem}${suffix}`
}

export function annotationPreviewUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'lexora-file:' && ANNOTATION_PREVIEW_HOSTS.has(parsed.hostname)
  }
  catch {
    return false
  }
}

export function imageContentRect(box: ImageDisplayBox, natural: ImageBounds): ImageDisplayBox {
  if (box.width <= 0 || box.height <= 0 || natural.width <= 0 || natural.height <= 0)
    return { left: box.left, top: box.top, width: 0, height: 0 }
  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  const width = natural.width * scale
  const height = natural.height * scale
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  }
}

export function displayPointToImage(clientX: number, clientY: number, display: ImageDisplayBox, natural: ImageBounds): AnnotationPoint | null {
  if (display.width <= 0 || display.height <= 0 || natural.width <= 0 || natural.height <= 0)
    return null
  return {
    x: (clientX - display.left) / display.width * natural.width,
    y: (clientY - display.top) / display.height * natural.height,
  }
}

export function clampAnnotationPoint(point: AnnotationPoint, bounds: ImageBounds): AnnotationPoint {
  return {
    x: Math.min(bounds.width, Math.max(0, point.x)),
    y: Math.min(bounds.height, Math.max(0, point.y)),
  }
}

export function annotationPointInside(point: AnnotationPoint, bounds: ImageBounds): boolean {
  return point.x >= -0.5 && point.y >= -0.5 && point.x <= bounds.width + 0.5 && point.y <= bounds.height + 0.5
}

export function annotationRectFromDrag(start: AnnotationPoint, end: AnnotationPoint, bounds: ImageBounds): ImageAnnotationRect | null {
  if (bounds.width < 1 || bounds.height < 1)
    return null
  const from = clampAnnotationPoint(start, bounds)
  const to = clampAnnotationPoint(end, bounds)
  const left = Math.min(from.x, to.x)
  const top = Math.min(from.y, to.y)
  const right = Math.max(from.x, to.x)
  const bottom = Math.max(from.y, to.y)
  const x = Math.round(left)
  const y = Math.round(top)
  const width = Math.min(Math.round(right) - x, bounds.width - x)
  const height = Math.min(Math.round(bottom) - y, bounds.height - y)
  if (width < 1 || height < 1 || x >= bounds.width || y >= bounds.height)
    return null
  return { x, y, width, height }
}

export interface AnnotationHistory {
  marks: readonly ImageAnnotationRect[]
  undone: readonly ImageAnnotationRect[]
}

export function emptyAnnotationHistory(): AnnotationHistory {
  return { marks: [], undone: [] }
}

export function annotationHistoryCommit(history: AnnotationHistory, rect: ImageAnnotationRect): AnnotationHistory {
  return { marks: [...history.marks, rect], undone: [] }
}

export function annotationHistoryUndo(history: AnnotationHistory): AnnotationHistory {
  const rect = history.marks.at(-1)
  if (!rect)
    return history
  return { marks: history.marks.slice(0, -1), undone: [...history.undone, rect] }
}

export function annotationHistoryRedo(history: AnnotationHistory): AnnotationHistory {
  const rect = history.undone.at(-1)
  if (!rect)
    return history
  return { marks: [...history.marks, rect], undone: history.undone.slice(0, -1) }
}

export type AnnotationHistoryCommand = 'undo' | 'redo'

export interface AnnotationShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

export function annotationHistoryShortcut(event: AnnotationShortcutEvent): AnnotationHistoryCommand | null {
  if (event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey))
    return null
  const key = event.key.toLowerCase()
  if (key === 'z')
    return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && event.ctrlKey && !event.shiftKey)
    return 'redo'
  return null
}

export function annotationMarker(index: number): string {
  if (index >= 1 && index <= 20)
    return String.fromCodePoint(0x245F + index)
  if (index >= 21 && index <= 35)
    return String.fromCodePoint(0x3251 + index - 21)
  if (index >= 36 && index <= 50)
    return String.fromCodePoint(0x32B1 + index - 36)
  return String(index)
}

export interface AnnotationMarkLayout {
  marker: string
  strokeWidth: number
  badge: { x: number, y: number, size: number }
}

export function annotationMarkLayout(rect: ImageAnnotationRect, index: number, bounds: ImageBounds): AnnotationMarkLayout {
  const strokeWidth = Math.max(2, Math.round(Math.min(bounds.width, bounds.height) / 500))
  const size = Math.min(bounds.width, bounds.height, Math.max(strokeWidth * 8, Math.round(Math.min(bounds.width, bounds.height) * 0.045)))
  const x = Math.min(Math.max(rect.x, 0), Math.max(bounds.width - size, 0))
  const preferredY = rect.y >= size ? rect.y - size : rect.y
  const y = Math.min(Math.max(preferredY, 0), Math.max(bounds.height - size, 0))
  return { marker: annotationMarker(index), strokeWidth, badge: { x, y, size: Math.max(size, 1) } }
}

export type AnnotationCanvas = Pick<CanvasRenderingContext2D, 'strokeStyle' | 'fillStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline' | 'drawImage' | 'strokeRect' | 'fillRect' | 'fillText'>

export function paintImageAnnotation(context: AnnotationCanvas, image: CanvasImageSource, bounds: ImageBounds, rects: readonly ImageAnnotationRect[], colors: { stroke: string, text: string }): void {
  context.drawImage(image, 0, 0, bounds.width, bounds.height)
  rects.forEach((rect, index) => {
    const layout = annotationMarkLayout(rect, index + 1, bounds)
    context.strokeStyle = colors.stroke
    context.lineWidth = layout.strokeWidth
    context.strokeRect(rect.x, rect.y, rect.width, rect.height)
    context.fillStyle = colors.stroke
    context.fillRect(layout.badge.x, layout.badge.y, layout.badge.size, layout.badge.size)
    context.fillStyle = colors.text
    context.font = `${Math.max(10, Math.round(layout.badge.size * 0.72))}px sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(layout.marker, layout.badge.x + layout.badge.size / 2, layout.badge.y + layout.badge.size / 2)
  })
}

export function imageElementCanvasReadable(image: CanvasImageSource & { complete?: boolean, naturalWidth?: number, naturalHeight?: number }): boolean {
  if (image.complete === false || (image.naturalWidth ?? 0) < 1 || (image.naturalHeight ?? 0) < 1)
    return false
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context)
    return false
  try {
    context.drawImage(image, 0, 0, 1, 1)
    context.getImageData(0, 0, 1, 1)
    return true
  }
  catch {
    return false
  }
}

export const ANNOTATION_EXPORT_MAX_SIDE = 16_384
export const ANNOTATION_EXPORT_MAX_PIXELS = 33_554_432

export function annotationExportFits(width: number, height: number): boolean {
  return width >= 1 && height >= 1 && width <= ANNOTATION_EXPORT_MAX_SIDE && height <= ANNOTATION_EXPORT_MAX_SIDE && width * height <= ANNOTATION_EXPORT_MAX_PIXELS
}

export async function renderAnnotatedPng(image: CanvasImageSource, width: number, height: number, rects: readonly ImageAnnotationRect[], colors: { stroke: string, text: string }): Promise<Blob> {
  if (!annotationExportFits(width, height))
    throw new Error('ANNOTATION_EXPORT_FAILED')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context)
    throw new Error('ANNOTATION_EXPORT_FAILED')
  paintImageAnnotation(context, image, { width, height }, rects, colors)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(value => resolve(value), 'image/png'))
  if (!blob)
    throw new Error('ANNOTATION_EXPORT_FAILED')
  return blob
}

export function pngAnimationFlag(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  if (signature.some((byte, index) => bytes[index] !== byte))
    return false
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const size = readUint32(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    if (type === 'acTL')
      return true
    if (type === 'IDAT' || type === 'IEND')
      return false
    offset += 12 + size
  }
  // acTL is required to precede IDAT. A prefix that reaches neither is not treated as animated;
  // export then uses the preview's current decoded frame.
  return false
}

export function webpAnimationFlag(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP')
    return false
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4)
    const size = bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24)
    if (type === 'ANIM' || type === 'ANMF')
      return true
    if (type === 'VP8X')
      return offset + 8 < bytes.length && (bytes[offset + 8]! & 0x02) !== 0
    if (size < 0)
      return false
    offset += 8 + size + (size & 1)
    if (offset > bytes.length)
      return false
  }
  return false
}

export async function readResponsePrefix(response: Response, length: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader)
    return new Uint8Array(await response.arrayBuffer()).subarray(0, length)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < length) {
      const next = await reader.read()
      if (next.done || !next.value)
        break
      chunks.push(next.value)
      total += next.value.byteLength
    }
  }
  finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(Math.min(total, length))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset)
    if (take <= 0)
      break
    bytes.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return bytes
}

export async function readAnimatedPreview(url: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!annotationPreviewUrlAllowed(url))
    throw new Error('ANNOTATION_PREVIEW_UNAVAILABLE')
  const response = await fetchImpl(url, { signal, cache: 'no-store' })
  if (!response.ok)
    throw new Error('ANNOTATION_PREVIEW_UNAVAILABLE')
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!type.includes('image/webp') && !type.includes('image/png') && !type.includes('image/apng'))
    return false
  const bytes = await readResponsePrefix(response, 256 * 1024)
  return type.includes('image/webp') ? webpAnimationFlag(bytes) : pngAnimationFlag(bytes)
}

export function annotationThemeColors(): { stroke: string, text: string } {
  const probe = document.createElement('span')
  probe.style.color = 'var(--buddy-accent-solid)'
  probe.style.backgroundColor = 'var(--buddy-text-on-accent)'
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const colors = {
    stroke: style.color && style.color !== 'rgba(0, 0, 0, 0)' ? style.color : '#2563eb',
    text: style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? style.backgroundColor : '#ffffff',
  }
  probe.remove()
  return colors
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export type AnnotationQuoteAction
  = | { kind: 'unavailable' }
    | { kind: 'choose' }
    | { kind: 'direct', targetId: string, named: boolean }

export function annotationQuoteAction(scope: Pick<SelectionReferenceRequest, 'targets' | 'defaultId' | 'isSplit'> | null): AnnotationQuoteAction {
  if (!scope?.targets.length)
    return { kind: 'unavailable' }
  if (scope.targets.length > 1)
    return { kind: 'choose' }
  const direct = getDirectSelectionReferenceTarget(scope)
  if (direct)
    return { kind: 'direct', targetId: direct.id, named: false }
  const preferred = scope.defaultId ? scope.targets.find(target => target.id === scope.defaultId) : undefined
  if (preferred)
    return { kind: 'direct', targetId: preferred.id, named: true }
  return { kind: 'choose' }
}

export interface AnnotationQuoteCheckpoint {
  sourceIdentity: string
  imageUrl: string
  targetId: string
  targetIdentity: string
}

export function annotationQuoteMatches(checkpoint: AnnotationQuoteCheckpoint, current: AnnotationQuoteCheckpoint | null): boolean {
  return !!current
    && current.sourceIdentity === checkpoint.sourceIdentity
    && current.imageUrl === checkpoint.imageUrl
    && current.targetId === checkpoint.targetId
    && current.targetIdentity === checkpoint.targetIdentity
}

export async function quoteAnnotatedImage(options: {
  checkpoint: AnnotationQuoteCheckpoint
  readRoute: () => AnnotationQuoteCheckpoint | null
  receive: (current: () => boolean) => Promise<boolean>
}): Promise<'added' | 'stale' | 'failed'> {
  const current = () => annotationQuoteMatches(options.checkpoint, options.readRoute())
  if (!current())
    return 'stale'
  const added = await options.receive(current)
  if (added)
    return 'added'
  return current() ? 'failed' : 'stale'
}

export function createSingleFlight() {
  let active = false
  return async function singleFlight<T>(action: () => Promise<T>): Promise<T | null> {
    if (active)
      return null
    active = true
    try {
      return await action()
    }
    finally {
      active = false
    }
  }
}

export interface AnnotatedImageQuote {
  scope: Omit<SelectionReferenceRequest, 'quote'>
  targetId: string
  name: string
  base64: string
  current: () => boolean
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let index = 0; index < length; index += 1)
    text += String.fromCharCode(bytes[offset + index] ?? 0)
  return text
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0)
}
