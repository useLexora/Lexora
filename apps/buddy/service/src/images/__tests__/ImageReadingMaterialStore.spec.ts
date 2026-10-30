import { mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImageReadingMaterialStore } from '../ImageReadingMaterialStore'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'image-material-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('owned image reading materials', () => {
  it('keeps exact text in separate conversation-owned files without replacing earlier results', async () => {
    const first = new ImageReadingMaterialStore(root, 'conversation-1')
    const second = new ImageReadingMaterialStore(root, 'conversation-2')
    const paths = await Promise.all([first.write('first\n😀'), first.write('second'), second.write('third')])
    expect(new Set(paths).size).toBe(3)
    expect(paths[0]).toMatch(/\/\.image-reading\/conversation-1\/[a-f0-9-]+\.txt$/)
    expect(paths[2]).toContain('/.image-reading/conversation-2/')
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(['first\n😀', 'second', 'third'])
    expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600)
  })

  it('rejects redirected material directories and leaves the destination unchanged', async () => {
    const external = await mkdtemp(join(tmpdir(), 'image-material-outside-'))
    try {
      await symlink(external, join(root, '.image-reading'))
      await expect(new ImageReadingMaterialStore(root, 'conversation').write('private content')).rejects.toThrow('identity changed')
      expect(await readdir(external)).toEqual([])
    }
    finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('rejects invalid ownership and cancellation before creating material directories', async () => {
    expect(() => new ImageReadingMaterialStore(root, '../other')).toThrow('owner')
    await expect(new ImageReadingMaterialStore(root, 'conversation').write('text', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(root)).toEqual([])
  })
})
