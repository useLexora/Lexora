import type { AnnotationCanvas } from '../imageAnnotation'
import type { TaskWorkspacePool } from '@/app/workbench/TaskWorkspacePool'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { buddyUserContentToText, createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { receiveReferenceMaterial } from '@/app/workbench/receiveReferenceMaterial'
import { chatComposerDocumentToUserContent, userContentToChatComposerDocument } from '@/modules/prompt-input'
import { WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { annotatedSnapshotName, annotationExportFits, annotationHistoryCommit, annotationHistoryRedo, annotationHistoryShortcut, annotationHistoryUndo, annotationMarkLayout, annotationPointInside, annotationPreviewUrlAllowed, annotationQuoteAction, annotationQuoteMatches, annotationRectFromDrag, bytesToBase64, createSingleFlight, displayPointToImage, emptyAnnotationHistory, imageContentRect, isStaticAnnotatableImageName, paintImageAnnotation, pngAnimationFlag, quoteAnnotatedImage, readAnimatedPreview, webpAnimationFlag } from '../imageAnnotation'

const bounds = { width: 200, height: 100 }
const natural = { width: 100, height: 100 }

describe('image annotation geometry', () => {
  it('maps the painted image inside letterboxing and ignores the padding', () => {
    const box = { left: 20, top: 40, width: 200, height: 100 }
    const content = imageContentRect(box, natural)
    expect(content).toEqual({ left: 70, top: 40, width: 100, height: 100 })
    expect(displayPointToImage(70, 40, content, natural)).toEqual({ x: 0, y: 0 })
    const outside = displayPointToImage(20, 40, content, natural)!
    expect(annotationPointInside(outside, natural)).toBe(false)
  })

  it('keeps the same source pixels when the display size changes', () => {
    const large = { left: 0, top: 10, width: 400, height: 200 }
    const small = { left: 30, top: 80, width: 100, height: 50 }
    expect(displayPointToImage(200, 110, large, bounds)).toEqual(displayPointToImage(80, 105, small, bounds))
  })

  it('clamps a drag that leaves the image and skips a click', () => {
    expect(annotationRectFromDrag({ x: 10.2, y: 8.4 }, { x: 1000, y: -40 }, bounds)).toEqual({ x: 10, y: 0, width: 190, height: 8 })
    expect(annotationRectFromDrag({ x: 40, y: 30 }, { x: 12.2, y: 11.4 }, bounds)).toEqual({ x: 12, y: 11, width: 28, height: 19 })
    expect(annotationRectFromDrag({ x: 5, y: 5 }, { x: 5.2, y: 8 }, bounds)).toBeNull()
    expect(annotationRectFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 }, bounds)).toBeNull()
  })

  it('numbers the next mark with the removed index and paints that badge', () => {
    const rects = [
      annotationRectFromDrag({ x: 0, y: 0 }, { x: 20, y: 20 }, bounds)!,
      annotationRectFromDrag({ x: 30, y: 10 }, { x: 70, y: 40 }, bounds)!,
    ]
    const kept = rects.slice(0, -1)
    const next = annotationRectFromDrag({ x: 80, y: 10 }, { x: 120, y: 40 }, bounds)!
    const marks = [...kept, next]
    expect(annotationMarkLayout(marks[1]!, 2, bounds).marker).toBe('②')
    const calls: string[] = []
    const context = {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: 'start' as CanvasTextAlign,
      textBaseline: 'alphabetic' as CanvasTextBaseline,
      drawImage: () => calls.push('image'),
      strokeRect: (x: number, y: number, width: number, height: number) => calls.push(`stroke:${x},${y},${width},${height}`),
      fillRect: (x: number, y: number, width: number, height: number) => calls.push(`badge:${x},${y},${width},${height}`),
      fillText: (text: string) => calls.push(`text:${text}`),
    }
    paintImageAnnotation(context as unknown as AnnotationCanvas, {} as CanvasImageSource, bounds, marks, { stroke: 'red', text: 'white' })
    const layout = annotationMarkLayout(next, 2, bounds)
    expect(calls).toContain(`stroke:${next.x},${next.y},${next.width},${next.height}`)
    expect(calls).toContain(`badge:${layout.badge.x},${layout.badge.y},${layout.badge.size},${layout.badge.size}`)
    expect(calls).toContain('text:②')
  })

  it('keeps the png suffix when the stem is truncated and rejects an oversized export', () => {
    expect(annotatedSnapshotName('folder/shot.webp')).toBe('shot-annotated.png')
    expect(annotatedSnapshotName(`${'a'.repeat(300)}.png`)).toMatch(/-annotated\.png$/)
    expect(annotatedSnapshotName(`${'a'.repeat(300)}.png`).length).toBe(180)
    expect(isStaticAnnotatableImageName('photo.JPEG')).toBe(true)
    expect(isStaticAnnotatableImageName('clip.gif')).toBe(false)
    expect(annotationExportFits(4096, 8192)).toBe(true)
    expect(annotationExportFits(8192, 8192)).toBe(false)
    expect(annotationExportFits(16_384, 16_384)).toBe(false)
  })
})

describe('image annotation history', () => {
  const first = { x: 1, y: 2, width: 10, height: 12 }
  const second = { x: 20, y: 8, width: 16, height: 14 }
  const shortcut = (key: string, modifiers: { ctrl?: boolean, meta?: boolean, shift?: boolean, alt?: boolean, composing?: boolean } = {}) => annotationHistoryShortcut({
    key,
    ctrlKey: !!modifiers.ctrl,
    metaKey: !!modifiers.meta,
    shiftKey: !!modifiers.shift,
    altKey: !!modifiers.alt,
    isComposing: modifiers.composing,
  })

  it('restores the undone mark and its number, then drops redo after a new mark', () => {
    const drawn = annotationHistoryCommit(annotationHistoryCommit(emptyAnnotationHistory(), first), second)
    const undone = annotationHistoryUndo(drawn)
    expect(undone.marks).toEqual([first])
    expect(undone.undone).toEqual([second])
    const restored = annotationHistoryRedo(undone)
    expect(restored.marks[1]).toBe(second)
    expect(annotationMarkLayout(restored.marks[1]!, restored.marks.length, bounds).marker).toBe('②')
    const replaced = annotationHistoryCommit(annotationHistoryUndo(restored), { x: 40, y: 10, width: 8, height: 8 })
    expect(replaced.undone).toEqual([])
    expect(annotationHistoryRedo(replaced)).toBe(replaced)
    expect(annotationHistoryUndo(emptyAnnotationHistory())).toEqual({ marks: [], undone: [] })
  })

  it('accepts the usual undo and redo chords without taking bare or alternate shortcuts', () => {
    expect(shortcut('z', { ctrl: true })).toBe('undo')
    expect(shortcut('Z', { meta: true })).toBe('undo')
    expect(shortcut('z', { ctrl: true, shift: true })).toBe('redo')
    expect(shortcut('z', { meta: true, shift: true })).toBe('redo')
    expect(shortcut('y', { ctrl: true })).toBe('redo')
    expect(shortcut('y', { meta: true })).toBeNull()
    expect(shortcut('z')).toBeNull()
    expect(shortcut('z', { ctrl: true, alt: true })).toBeNull()
    expect(shortcut('z', { ctrl: true, composing: true })).toBeNull()
    expect(shortcut('y', { ctrl: true, shift: true })).toBeNull()
  })
})

describe('image annotation routes', () => {
  const checkpoint = { sourceIdentity: 'source', imageUrl: 'lexora-file://media/?path=a.png', targetId: 'task', targetIdentity: 'draft-1' }

  it('quotes a single clear target directly and asks to choose when several candidates exist', () => {
    const target = { id: 'task', identity: 'draft-1', label: 'Pane 1 · Notes' }
    const other = { id: 'other', identity: 'draft-2', label: 'Pane 2 · Other' }
    expect(annotationQuoteAction({ targets: [target], defaultId: 'task', isSplit: false })).toEqual({ kind: 'direct', targetId: 'task', named: false })
    expect(annotationQuoteAction({ targets: [target], defaultId: 'task', isSplit: true })).toEqual({ kind: 'direct', targetId: 'task', named: true })
    expect(annotationQuoteAction({ targets: [target, other], defaultId: 'task', isSplit: true })).toEqual({ kind: 'choose' })
    expect(annotationQuoteAction({ targets: [target, other], defaultId: null, isSplit: true })).toEqual({ kind: 'choose' })
    expect(annotationQuoteAction(null)).toEqual({ kind: 'unavailable' })
  })

  it('drops a quote when the image, source, or target identity changes', async () => {
    expect(annotationQuoteMatches(checkpoint, checkpoint)).toBe(true)
    for (const current of [
      null,
      { ...checkpoint, imageUrl: 'lexora-file://media/?path=b.png' },
      { ...checkpoint, sourceIdentity: 'next' },
      { ...checkpoint, targetId: 'other' },
      { ...checkpoint, targetIdentity: 'draft-2' },
    ])
      expect(annotationQuoteMatches(checkpoint, current)).toBe(false)
    let route = checkpoint
    const receive = vi.fn(async (current: () => boolean) => {
      route = { ...checkpoint, targetIdentity: 'draft-2' }
      return current()
    })
    expect(await quoteAnnotatedImage({ checkpoint, readRoute: () => route, receive })).toBe('stale')
    expect(receive).toHaveBeenCalledOnce()
  })

  it('runs one quote at a time and reports a failed import without changing the route', async () => {
    const flight = createSingleFlight()
    let release!: () => void
    const first = flight(() => new Promise<string>((resolve) => {
      release = () => {
        resolve('ok')
      }
    }))
    expect(await flight(async () => 'again')).toBeNull()
    release()
    expect(await first).toBe('ok')
    const receive = vi.fn(async () => false)
    expect(await quoteAnnotatedImage({ checkpoint, readRoute: () => checkpoint, receive })).toBe('failed')
  })

  it('does not import a snapshot after the preview image or draft changes', async () => {
    const f = quoteFixture()
    const pending = Promise.withResolvers<string>()
    f.composer.importFileSnapshot.mockReturnValueOnce(pending.promise)
    let image = 'lexora-file://media/?path=a.png'
    const receiving = receiveReferenceMaterial({
      ...f.options,
      material: { kind: 'file', name: 'a-annotated.png', mimeType: 'image/png', base64: bytesToBase64(Uint8Array.from([1, 2, 3])) },
      current: () => image === 'lexora-file://media/?path=a.png' && f.composer.draftId.value === 'draft-1',
    })
    image = 'lexora-file://media/?path=b.png'
    f.composer.draftId.value = 'draft-2'
    pending.resolve('snapshot-1')
    expect(await receiving).toBe(false)
    expect(f.composer.composerContent.value.attrs?.panelResourceIds ?? []).toEqual([])
    expect(f.task.flushDrafts).not.toHaveBeenCalled()
  })
})

describe('animated preview detection', () => {
  it('recognizes animated WebP and APNG without treating ordinary images as animated', async () => {
    expect(webpAnimationFlag(webp(true))).toBe(true)
    expect(webpAnimationFlag(webp(false))).toBe(false)
    expect(pngAnimationFlag(png('acTL'))).toBe(true)
    expect(pngAnimationFlag(png('IDAT'))).toBe(false)
    const fetchImpl = vi.fn(async () => new Response(png('acTL'), { headers: { 'content-type': 'image/png' } }))
    expect(await readAnimatedPreview('lexora-file://media/?path=a.png', new AbortController().signal, fetchImpl)).toBe(true)
    expect(annotationPreviewUrlAllowed('lexora-file://skill-preview/?path=a.webp')).toBe(false)
    await expect(readAnimatedPreview('lexora-file://skill-preview/?path=a.webp', new AbortController().signal, fetchImpl)).rejects.toThrow('ANNOTATION_PREVIEW_UNAVAILABLE')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

function webp(animated: boolean): Uint8Array<ArrayBuffer> {
  return ownedBytes([
    ...asciiBytes('RIFF'),
    0,
    0,
    0,
    0,
    ...asciiBytes('WEBP'),
    ...asciiBytes('VP8X'),
    10,
    0,
    0,
    0,
    animated ? 0x02 : 0,
  ])
}

function png(chunk: 'acTL' | 'IDAT'): Uint8Array<ArrayBuffer> {
  return ownedBytes([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
    0,
    0,
    0,
    0,
    ...asciiBytes(chunk),
  ])
}

function ownedBytes(values: number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(values.length))
  bytes.set(values)
  return bytes
}

function asciiBytes(value: string): number[] {
  return [...value].map(char => char.charCodeAt(0))
}

function quoteFixture() {
  const document = shallowRef(userContentToChatComposerDocument(createBuddyUserContent('Keep this draft')))
  const composer = {
    draftId: shallowRef('draft-1'),
    composerContent: document,
    draft: shallowRef('Keep this draft'),
    selectSource: vi.fn(async () => 'resource-1'),
    importFileSnapshot: vi.fn(async () => 'snapshot-1'),
    updateComposerContent: (_text: string, value: typeof document.value) => { document.value = value },
  }
  const task = { workspace: { composer }, flushDrafts: vi.fn(async () => true) }
  const references = new WorkbenchSelectionReferences({ targets: () => [{
    id: 'task-view',
    identity: 'draft-1',
    scope: 'draft:1',
    label: 'Draft',
    read: () => chatComposerDocumentToUserContent(document.value),
    write: content => composer.updateComposerContent(buddyUserContentToText(content), userContentToChatComposerDocument(content)),
  }] })
  references.registerProvider('fixture', { captureSource: () => ({ identity: 'source', owner: null }) })
  const controller = { layout: { views: { 'task-view': { resource: { scheme: 'draft' } } } } } as unknown as WorkbenchController
  const pool = { peek: () => task } as unknown as TaskWorkspacePool
  const scope = references.captureScope('source-view')!
  return { composer, task, options: { references, controller, pool, scope, targetId: 'task-view', current: () => true } }
}
