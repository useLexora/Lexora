import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { ExtensionResourceStore } from '../../../../platform/extensions/ExtensionResourceStore'
import { readSpaceFileResource } from '../readSpaceFileResource'

it('copies an authorized Space image without text decoding or another selection and checks authorization again before publishing it', async () => {
  const root = await createTemporaryDirectory('lexora-space-resource-')
  const path = join(root, 'wallpaper.png')
  const bytes = Buffer.from([0, 255, 42, 128])
  await writeFile(path, bytes)
  const target = { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'wallpaper.png' }
  const signal = new AbortController().signal
  let allowed = true
  const locate = async () => {
    if (!allowed)
      throw new Error('FILE_PERMISSION_REVOKED')
    return { path, kind: 'file' as const }
  }
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const response = await readSpaceFileResource(target, signal, locate)
  const resource = await store.import('tests.images', 'wallpaper.png', 'image/png', response, signal, () => {})
  expect(await store.readBytes('tests.images', resource.id, 0, 4, signal, false)).toMatchObject({ base64: bytes.toString('base64'), eof: true })
  const revoked = await readSpaceFileResource(target, signal, locate)
  allowed = false
  await expect(store.import('tests.images', 'revoked.png', 'image/png', revoked, signal, () => {})).rejects.toThrow('FILE_PERMISSION_REVOKED')
  expect(await store.list('tests.images', false)).toEqual([resource])
  expect(await readFile(path)).toEqual(bytes)
})
