import type { InputModel } from '../../providers/modelCapabilities'
import type { AttachmentRecord } from '../../storage/attachmentRepository'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentImageStore } from '../AttachmentImageStore'

const model: InputModel = { api: 'openai-completions', provider: 'fixture', id: 'vision', name: 'Vision', baseUrl: 'https://example.test', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('stable attachment image inputs', () => {
  it('resizes a valid large image once and keeps the original and encoded input across restart', async () => {
    const fixture = await createFixture(png(3000, 1500))
    const store = new AttachmentImageStore()
    const first = await store.prepare(fixture.record, fixture.bytes, fixture.directory, model)
    expect(first).not.toBeNull()
    const image = PhotonImage.new_from_byteslice(Buffer.from(first!.image.data, 'base64'))
    try {
      expect([image.get_width(), image.get_height()]).toEqual([2000, 1000])
    }
    finally {
      image.free()
    }
    expect(first!.image.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
    expect(first!.note).toContain('original 3000x1500')
    const saved = await readFile(join(fixture.directory, 'attachment.json'))
    expect(await new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, model)).toEqual(first)
    expect(await readFile(join(fixture.directory, 'attachment.json'))).toEqual(saved)
    expect(await readFile(fixture.record.storedPath)).toEqual(fixture.bytes)
  })

  it('uses the first model profile and does not rewrite history for a stricter model', async () => {
    const fixture = await createFixture(png(80, 40))
    const firstModel = { ...model, inputLimits: { images: { resize: { maxWidth: 40, maxHeight: 40, maxBytes: 1024 } } } }
    const first = await new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, firstModel)
    expect(first!.image.data.length).toBeLessThanOrEqual(1024)
    const stricter = { ...model, inputLimits: { images: { resize: { maxWidth: 20 } } } }
    expect(await new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, stricter)).toBeNull()
    expect(await new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, model)).toEqual(first)
  })

  it('converts a GIF to a static PNG preview and describes the lost animation', async () => {
    const fixture = await createFixture(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image/gif')
    const result = await new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, model)
    expect(result!.image.mimeType).toBe('image/png')
    expect(result!.note).toContain('animation is not supplied')
    expect(Buffer.from(result!.image.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })

  it('rejects invalid image bytes and cache corruption instead of sending unchecked bytes', async () => {
    const invalid = await createFixture(Buffer.from('not a PNG'))
    await expect(new AttachmentImageStore().prepare(invalid.record, invalid.bytes, invalid.directory, model)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
    const fixture = await createFixture(png(2, 1))
    await new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, model)
    const path = join(fixture.directory, 'attachment.json')
    const cache = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...cache, data: 'corrupted' }))
    await expect(new AttachmentImageStore().prepare(fixture.record, fixture.bytes, fixture.directory, model)).rejects.toThrow('RESOURCE_MATERIALIZATION_FAILED')
  })
})

async function createFixture(bytes: Buffer, mimeType = 'image/png') {
  const root = await mkdtemp(join(tmpdir(), 'buddy-image-input-'))
  roots.push(root)
  const record: AttachmentRecord = { id: 'attachment', conversationId: 'conversation', messageId: 'message', draftId: null, createdAt: new Date(0).toISOString(), name: 'image', mimeType, sizeBytes: bytes.length, storedPath: join(root, 'original') }
  await writeFile(record.storedPath, bytes)
  return { directory: join(root, 'image-inputs'), record, bytes }
}

function png(width: number, height: number): Buffer {
  const image = new PhotonImage(new Uint8Array(width * height * 4).fill(255), width, height)
  try {
    return Buffer.from(image.get_bytes())
  }
  finally {
    image.free()
  }
}
