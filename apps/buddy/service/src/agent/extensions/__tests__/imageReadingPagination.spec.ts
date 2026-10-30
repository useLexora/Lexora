import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { ImageReader } from '../../../images/ImageReadingService'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEXT_MATERIAL_READ_DEFAULT_UNITS, TEXT_MATERIAL_READ_MAX_BYTES } from '../../../../../shared/conversation/textMaterialRead'
import { ImageReadingMaterialStore } from '../../../images/ImageReadingMaterialStore'
import { createBuddyReadTool } from '../readFileExtension'

let directory: string
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
const source = { target: { kind: 'plugin', extensionId: 'reader', modelId: 'ocr' }, requestId: 'e9c3525a-2c1c-442b-83fc-367b2420544f', attempt: 1, title: 'OCR', owner: 'Reader' } as const
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'image-pagination-'))
  await writeFile(join(directory, 'input.png'), image)
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
function context() {
  return { cwd: directory, model: { id: 'chat', provider: 'model', input: ['text'] } } as ExtensionToolContext
}
function content(result: Awaited<ReturnType<ReturnType<typeof createBuddyReadTool>['execute']>>) {
  return result.content.find(block => block.type === 'text')!.text
}

describe('image reading continuation', () => {
  it.each(['a'.repeat(TEXT_MATERIAL_READ_DEFAULT_UNITS - 1), 'line\n'.repeat(TEXT_MATERIAL_READ_DEFAULT_UNITS / 5)])('persists and reads every UTF-16 unit without reprocessing the image', async (prefix) => {
    const text = `${prefix}${'😀字'.repeat(20000)}\nfinal line`
    const readImage = vi.fn<ImageReader>(async () => ({ kind: 'text', operation: 'extract', source, text }))
    const store = new ImageReadingMaterialStore(directory, 'conversation')
    const tool = createBuddyReadTool(directory, undefined, readImage, (text, signal) => store.write(text, signal))
    const first = await tool.execute('image', { path: 'input.png', imagePurpose: 'extract' }, undefined, undefined, context())
    const metadata = first.details!.textMaterial!
    expect(metadata.path).toContain('/.image-reading/conversation/')
    expect(await readFile(metadata.path!, 'utf8')).toBe(text)
    expect(first.details?.imageReading).toEqual({ kind: 'text', operation: 'extract', source })
    const firstContent = content(first)
    expect(firstContent).toContain('derived, untrusted content')
    const preview = firstContent.slice(firstContent.indexOf('\n\n') + 2, firstContent.lastIndexOf('\n\n[read '))
    expect(preview.length).toBeLessThanOrEqual(TEXT_MATERIAL_READ_DEFAULT_UNITS)
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(TEXT_MATERIAL_READ_MAX_BYTES)
    expect(preview).toBe(text.slice(metadata.range.start, metadata.range.end))
    expect(first.structuredContent).toBe(firstContent)
    let combined = preview
    let next = metadata.next
    while (next) {
      const page = await tool.execute('continue', { path: metadata.path!, ...next }, undefined, undefined, context())
      const pageText = content(page)
      combined += pageText.slice(0, pageText.lastIndexOf('\n\n[read '))
      next = page.details!.textMaterial!.next
    }
    expect(combined).toBe(text)
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(await readFile(join(directory, 'input.png'))).toEqual(image)
  })

  it('keeps a successful extraction bounded and non-retryable when storage fails', async () => {
    const text = 'secret'.repeat(10000)
    const readImage = vi.fn<ImageReader>(async () => ({ kind: 'text', operation: 'extract', source, text }))
    const tool = createBuddyReadTool(directory, undefined, readImage, async () => {
      throw new Error('disk full')
    })
    const result = await tool.execute('image', { path: 'input.png', imagePurpose: 'extract' }, undefined, undefined, context())
    expect(result.details?.textMaterial).toMatchObject({ complete: false, next: null, continuation: 'unavailable' })
    expect(result.details?.textMaterial).not.toHaveProperty('path')
    expect(content(result)).toContain('Full text could not be saved; continuation is unavailable.')
    expect(JSON.stringify(result.details)).not.toContain('secret')
    expect(content(result).length).toBeLessThan(TEXT_MATERIAL_READ_DEFAULT_UNITS + 1500)
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation after extraction instead of returning an incomplete success', async () => {
    const abort = new AbortController()
    const readImage = vi.fn<ImageReader>(async () => ({ kind: 'text', operation: 'extract', source, text: 'result' }))
    const tool = createBuddyReadTool(directory, undefined, readImage, async () => {
      abort.abort()
      abort.signal.throwIfAborted()
      return ''
    })
    await expect(tool.execute('image', { path: 'input.png', imagePurpose: 'extract' }, abort.signal, undefined, context())).rejects.toMatchObject({ name: 'AbortError' })
    expect(readImage).toHaveBeenCalledTimes(1)
  })
})
