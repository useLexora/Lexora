import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageBlobStore } from '../ImageBlobStore'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('immutable conversation image blobs', () => {
  it('publishes one binary file for concurrent identical writes and verifies it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-image-blobs-'))
    roots.push(root)
    const store = new ImageBlobStore(join(root, 'images'))
    const bytes = Buffer.from('fixture-image-bytes')
    const references = await Promise.all(Array.from({ length: 4 }, () => store.put(bytes.toString('base64'))))
    expect(references.every(reference => reference.sha256 === references[0]!.sha256)).toBe(true)
    expect(await readdir(store.directory)).toEqual([references[0]!.sha256])
    expect(await new ImageBlobStore(store.directory).read(references[0]!)).toEqual(bytes)
  })

  it('rejects corrupt, missing, linked and malformed blobs without replacing their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-image-blobs-'))
    roots.push(root)
    const store = new ImageBlobStore(join(root, 'images'))
    const data = Buffer.from('original').toString('base64')
    const reference = await store.put(data)
    const path = join(store.directory, reference.sha256)
    await writeFile(path, 'modified')
    await expect(store.read(reference)).rejects.toThrow('RESOURCE_MATERIALIZATION_FAILED')
    await expect(store.put(data)).rejects.toThrow('RESOURCE_MATERIALIZATION_FAILED')
    await rm(path)
    await expect(store.read(reference)).rejects.toThrow()
    await writeFile(join(root, 'outside'), 'original')
    await symlink(join(root, 'outside'), path)
    await expect(store.read(reference)).rejects.toThrow('RESOURCE_MATERIALIZATION_FAILED')
    await expect(store.put('not base64!')).rejects.toThrow('RESOURCE_MATERIALIZATION_FAILED')
    await expect(store.read({ ...reference, sha256: '../outside' })).rejects.toThrow()
  })
})
