import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { ExtensionResourceStore } from '../ExtensionResourceStore'

const owner = 'tests.references'

it('resolves only current owned grants without copying or modifying original files', async () => {
  const root = await createTemporaryDirectory('lexora-inference-reference-')
  const path = join(root, '模型 文件.gguf')
  await writeFile(path, 'fixture weights')
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const [resource] = await store.grant(owner, [path], () => {})
  const before = await stat(path, { bigint: true })
  expect(await store.referencePath(owner, resource!.id)).toBe(await realpath(path))
  const handle = await store.openReference(owner, resource!.id)
  try {
    expect(await handle.readFile('utf8')).toBe('fixture weights')
  }
  finally { await handle.close() }
  const after = await stat(path, { bigint: true })
  expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.size, before.mtimeNs, before.ctimeNs])
  await expect(store.referencePath('tests.other', resource!.id)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await store.revoke(owner, resource!.id)
  await expect(store.referencePath(owner, resource!.id)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await readFile(path, 'utf8')).toBe('fixture weights')
})

it('rejects a replacement at a granted path and revocation of a directory grant', async () => {
  const root = await createTemporaryDirectory('lexora-inference-reference-')
  const directory = join(root, '模型目录')
  await mkdir(directory)
  const path = join(directory, 'weights.gguf')
  await writeFile(path, 'first')
  const store = new ExtensionResourceStore(join(root, 'extensions'))
  const [resource] = await store.grant(owner, [path], () => {})
  await rename(path, `${path}.original`)
  await writeFile(path, 'other')
  await expect(store.referencePath(owner, resource!.id)).rejects.toThrow('EXTENSION_RESOURCE_CHANGED')
  const granted = await store.grantDirectory(owner, directory, () => {})
  const input = { directoryId: granted.id, path: 'weights.gguf' }
  expect(await store.directoryReferencePath(owner, input)).toBe(await realpath(path))
  await expect(store.directoryReferencePath(owner, { ...input, path: '../outside' })).rejects.toThrow()
  await expect(store.directoryReferencePath('tests.other', input)).rejects.toThrow()
  await store.revokeDirectory(owner, granted.id, () => {})
  await expect(store.directoryReferencePath(owner, input)).rejects.toThrow()
})
