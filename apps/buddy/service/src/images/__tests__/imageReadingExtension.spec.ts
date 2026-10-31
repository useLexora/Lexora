import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { ToolMediaReferenceMessage } from '../../agent/context/ToolMediaReference'
import type { ImageReader, ImageReadingInput } from '../ImageReadingService'
import { Buffer } from 'node:buffer'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBuddyInputReference, createBuddyInputReferenceMessage } from '../../agent/context/BuddyInputReference'
import { projectMessageImages } from '../../agent/context/projectBuddyInput'
import { ImageBlobStore } from '../../attachments/ImageBlobStore'
import { createImageReadingCapability, createImageReadingTool, IMAGE_READING_TOOL_NAME } from '../imageReadingExtension'
import { ImageReadingMaterialStore } from '../ImageReadingMaterialStore'
import { imageReadingRequest } from '../imageReadingRequest'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
const model = { id: 'text', provider: 'fixture', input: ['text'] } as Model<Api>
const source = { target: { kind: 'model', providerId: 'fixture', modelId: 'vision' }, requestId: 'request', attempt: 1, title: 'Vision', owner: 'fixture' } as const
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'image-reading-tool-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function setup() {
  const manager = SessionManager.inMemory(root)
  const store = new ImageBlobStore(join(root, 'images'))
  const materials = new ImageReadingMaterialStore(root, 'conversation')
  const requests: Omit<ImageReadingInput, 'runId'>[] = []
  const readImage: ImageReader = async (input) => {
    requests.push(input)
    return { kind: 'text', operation: input.operation, text: 'Image 1: red circle. Image 2: blue square.', source }
  }
  const options = { cwd: root, store, readImage, writeMaterial: (text: string, signal?: AbortSignal) => materials.write(text, signal), getGrants: () => [{ root, canonicalRoot: root, kind: 'workspace' as const, grantId: 'workspace' }] }
  const context = { cwd: root, model, sessionManager: manager } as unknown as ExtensionToolContext
  return { manager, store, requests, options, context, tool: createImageReadingTool(options) }
}

function user(manager: SessionManager, id: string, prompt: string) {
  manager.appendMessage(createBuddyInputReferenceMessage(createBuddyInputReference({ messageId: id, prompt, images: [] }), 0))
}

async function saveImage(fixture: ReturnType<typeof setup>) {
  const blob = await fixture.store.put(png.toString('base64'))
  const message: ToolMediaReferenceMessage = { role: 'toolResult', toolCallId: 'browser', toolName: 'browser_screenshot', timestamp: 1, isError: false, content: [{ type: 'image', mimeType: 'image/png', data: '' }], buddyToolMedia: { version: 1, images: [{ ...blob, contentIndex: 0, mimeType: 'image/png' }] } }
  fixture.manager.appendMessage(message)
  return { reference: `image:${blob.sha256}`, message }
}

describe('image inspection contract', () => {
  it('supplies the current user task and all ordered images in a single visual request', async () => {
    const fixture = setup()
    user(fixture.manager, 'old', 'Previous unrelated task')
    user(fixture.manager, 'current', 'Compare the two panels and identify every changed control.')
    await writeFile(join(root, 'before.png'), png)
    await writeFile(join(root, 'after.png'), png)
    const result = await fixture.tool.execute('inspect', { images: ['before.png', 'after.png'], question: 'Which switch changed state?' }, undefined, undefined, fixture.context)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]).toMatchObject({ request: 'Compare the two panels and identify every changed control.', question: 'Which switch changed state?', operation: 'understand', images: [{ reference: 'before.png' }, { reference: 'after.png' }] })
    expect(fixture.requests[0]!.images.map(value => value.image.data)).toEqual([png.toString('base64'), png.toString('base64')])
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Sources: ["before.png","after.png"]') }])
    expect(result).toMatchObject({ details: { imageReading: { source } } })
  })

  it('uses the latest consumed input after a follow-up and does not confuse assistant text with the task', () => {
    const fixture = setup()
    user(fixture.manager, 'first', 'Read the title.')
    user(fixture.manager, 'follow-up', 'Now compare the colors instead.')
    expect(imageReadingRequest(fixture.context)).toBe('Now compare the colors instead.')
  })

  it('preserves a tool image for text-only inspection and checks the current branch identity', async () => {
    const fixture = setup()
    user(fixture.manager, 'input', 'Inspect the screenshot.')
    const branch = fixture.manager.getLeafId()!
    const image = await saveImage(fixture)
    const projected = projectMessageImages(image.message, model)
    expect(projected).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining(image.reference) }] })
    await fixture.tool.execute('inspect', { images: [image.reference], question: 'Which shape is visible?' }, undefined, undefined, fixture.context)
    expect(fixture.requests[0]?.images[0]).toEqual({ reference: image.reference, image: { type: 'image', mimeType: 'image/png', data: png.toString('base64') } })
    fixture.manager.branch(branch)
    await expect(fixture.tool.execute('other-branch', { images: [image.reference], question: 'Inspect' }, undefined, undefined, fixture.context)).rejects.toThrow('IMAGE_REFERENCE_UNAVAILABLE')
    expect(fixture.requests).toHaveLength(1)
  })

  it('rejects unknown references and missing members instead of partially comparing images', async () => {
    const fixture = setup()
    await writeFile(join(root, 'present.png'), png)
    await expect(fixture.tool.execute('missing', { images: ['present.png', 'missing.png'], question: 'Compare' }, undefined, undefined, fixture.context)).rejects.toThrow()
    await expect(fixture.tool.execute('unknown', { images: [`image:${'a'.repeat(64)}`], question: 'Inspect' }, undefined, undefined, fixture.context)).rejects.toThrow('IMAGE_REFERENCE_UNAVAILABLE')
    expect(fixture.requests).toEqual([])
  })

  it('declares file reads to the permission system and rejects symlink escape before sending pixels', async () => {
    const fixture = setup()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'image-outside-')))
    try {
      await writeFile(join(outside, 'private.png'), png)
      await symlink(outside, join(root, 'escape'))
      const capability = createImageReadingCapability(fixture.options)
      expect(await capability.classify({ toolName: IMAGE_READING_TOOL_NAME, input: { images: ['escape/private.png'], question: 'Read' } } as never, new AbortController().signal)).toEqual({ access: 'read', paths: [{ mode: 'existing', path: 'escape/private.png' }] })
      await expect(fixture.tool.execute('escape', { images: ['escape/private.png'], question: 'Read' }, undefined, undefined, fixture.context)).rejects.toThrow()
      expect(fixture.requests).toEqual([])
    }
    finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('returns the normalized native images with their source identity and size notes', async () => {
    const fixture = setup()
    const saved = await saveImage(fixture)
    const image = { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }
    const tool = createImageReadingTool({ ...fixture.options, readImage: async () => ({ kind: 'native', images: [{ reference: saved.reference, image, note: 'Original 4000x2000, supplied 2000x1000.' }] }) })
    const result = await tool.execute('native', { images: [saved.reference], question: 'Inspect' }, undefined, undefined, fixture.context)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(saved.reference) }, image])
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('supplied 2000x1000') })
  })
})
