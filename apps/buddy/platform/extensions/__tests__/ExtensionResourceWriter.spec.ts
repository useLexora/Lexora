import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ExtensionResourceWriter } from '../ExtensionResourceWriter'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-resource-export-'))
  roots.push(root)
  const target = join(root, 'design.unknown')
  await writeFile(target, 'original')
  return { root, target }
}

it('commits complete binary output atomically and preserves the source until commit', async () => {
  const { root, target } = await fixture()
  const bytes = Buffer.from([0, 255, 17, 90, 2])
  const writer = await ExtensionResourceWriter.create(target, bytes.length, () => {})
  await writer.append(0, bytes.subarray(0, 2).toString('base64'))
  expect(await readFile(target, 'utf8')).toBe('original')
  await expect(writer.commit()).rejects.toThrow('EXTENSION_RESOURCE_WRITE_INCOMPLETE')
  await writer.append(2, bytes.subarray(2).toString('base64'))
  await writer.commit()
  await writer.dispose()
  expect(await readFile(target)).toEqual(bytes)
  expect(await readdir(root)).toEqual(['design.unknown'])
})

it('discards cancelled and expired writes without overwriting user data', async () => {
  const { root, target } = await fixture()
  let current = true
  const writer = await ExtensionResourceWriter.create(target, 4, () => {
    if (!current)
      throw new Error('expired')
  })
  await writer.append(0, Buffer.from('new!').toString('base64'))
  current = false
  await expect(writer.commit()).rejects.toThrow('expired')
  await writer.dispose()
  await expect(writer.append(4, 'YQ==')).rejects.toThrow('EXTENSION_RESOURCE_WRITE_EXPIRED')
  expect(await readFile(target, 'utf8')).toBe('original')
  expect(await readdir(root)).toEqual(['design.unknown'])
})

it('refuses to overwrite a target changed after selection and rejects invalid chunks', async () => {
  const { root, target } = await fixture()
  const writer = await ExtensionResourceWriter.create(target, 4, () => {})
  await expect(writer.append(1, 'YQ==')).rejects.toThrow('EXTENSION_RESOURCE_WRITE_RANGE')
  await expect(writer.append(0, Buffer.alloc(97 * 1024).toString('base64'))).rejects.toThrow('EXTENSION_RESOURCE_WRITE_RANGE')
  await writer.append(0, Buffer.from('new!').toString('base64'))
  await writeFile(target, 'external change')
  await expect(writer.commit()).rejects.toThrow('EXTENSION_RESOURCE_SAVE_TARGET_CHANGED')
  await writer.dispose()
  expect(await readFile(target, 'utf8')).toBe('external change')
  expect(await readdir(root)).toEqual(['design.unknown'])
})

it('supports empty exports without requiring a data chunk', async () => {
  const { root } = await fixture()
  const target = join(root, 'empty.txt')
  const writer = await ExtensionResourceWriter.create(target, 0, () => {})
  await writer.commit()
  await writer.dispose()
  expect(await readFile(target, 'utf8')).toBe('')
})
