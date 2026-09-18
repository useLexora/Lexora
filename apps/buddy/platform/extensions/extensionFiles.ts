import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate/browser'
import { extensionPathSchema } from '../../shared/extensions/extensionManifest'
import { fileStorage } from '../filesystem/fileStorage'

export const EXTENSION_FILE_LIMIT = 4 * 1024 * 1024
export const EXTENSION_PACKAGE_LIMIT = 16 * 1024 * 1024
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

export async function readExtensionFile(path: string, limit = EXTENSION_FILE_LIMIT): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit)
      throw new Error('EXTENSION_FILE_LIMIT')
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead)
        break
      length += result.bytesRead
    }
    if (length > limit || length !== info.size)
      throw new Error('EXTENSION_FILE_CHANGED')
    return buffer.subarray(0, length)
  }
  finally { await handle.close() }
}

export async function readExtensionDirectory(directory: string): Promise<Map<string, Uint8Array>> {
  const root = await realpath(directory)
  const files = new Map<string, Uint8Array>()
  async function walk(folder: string) {
    const entries = await readdir(folder, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(folder, entry.name)
      const name = relative(root, path).replaceAll('\\', '/')
      if (entry.isSymbolicLink() || !extensionPathSchema.safeParse(name).success)
        throw new Error('EXTENSION_UNSAFE_PATH')
      if (entry.isDirectory()) {
        await walk(path)
      }
      else if (entry.isFile()) {
        files.set(name, await readExtensionFile(path))
        validateExtensionFiles(files)
      }
      else { throw new Error('EXTENSION_UNSAFE_PATH') }
    }
  }
  await walk(root)
  return files
}

export function unpackExtension(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > EXTENSION_PACKAGE_LIMIT)
    throw new Error('EXTENSION_PACKAGE_LIMIT')
  const files = new Map<string, Uint8Array>()
  const names = new Set<string>()
  let failure: Error | undefined
  let total = 0
  let completed = 0
  let count = 0
  const unzip = new Unzip((file) => {
    count++
    const name = file.name.endsWith('/') ? file.name.slice(0, -1) : file.name
    const normalized = name.toLowerCase()
    if (count > 512 || !extensionPathSchema.safeParse(name).success || names.has(normalized) || (file.originalSize ?? 0) > EXTENSION_FILE_LIMIT) {
      failure = new Error('EXTENSION_UNSAFE_PACKAGE')
      file.terminate()
      return
    }
    names.add(normalized)
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (error)
        failure = new Error('EXTENSION_INVALID_ARCHIVE')
      if (failure)
        return file.terminate()
      size += chunk.byteLength
      total += chunk.byteLength
      if (size > EXTENSION_FILE_LIMIT || total > EXTENSION_PACKAGE_LIMIT) {
        failure = new Error('EXTENSION_PACKAGE_LIMIT')
        file.terminate()
        return
      }
      chunks.push(chunk)
      if (final) {
        completed++
        if (!file.name.endsWith('/'))
          files.set(name, Buffer.concat(chunks, size))
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let index = 0; index < bytes.byteLength; index += 1024) {
      if (failure)
        break
      unzip.push(bytes.subarray(index, index + 1024), index + 1024 >= bytes.byteLength)
    }
  }
  catch { failure ??= new Error('EXTENSION_INVALID_ARCHIVE') }
  if (failure)
    throw failure
  if (!count || count !== completed)
    throw new Error('EXTENSION_INVALID_ARCHIVE')
  validateExtensionFiles(files)
  return files
}

export function validateExtensionFiles(files: ReadonlyMap<string, Uint8Array>): void {
  let total = 0
  const names = new Set<string>()
  if (files.size > 512)
    throw new Error('EXTENSION_PACKAGE_LIMIT')
  for (const [name, bytes] of files) {
    if (!extensionPathSchema.safeParse(name).success || names.has(name.toLowerCase()))
      throw new Error('EXTENSION_UNSAFE_PATH')
    names.add(name.toLowerCase())
    total += bytes.byteLength
    if (bytes.byteLength > EXTENSION_FILE_LIMIT || total > EXTENSION_PACKAGE_LIMIT)
      throw new Error('EXTENSION_PACKAGE_LIMIT')
  }
}

export async function writeExtensionJson(path: string, value: unknown, beforeCommit: () => void = () => {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    }
    finally { await handle.close() }
    beforeCommit()
    await fileStorage.replace(temporary, path)
    await fileStorage.syncDirectory(dirname(path))
  }
  finally { await rm(temporary, { force: true }) }
}

export async function verifiedExtensionAsset(root: string, path: string, hash: string): Promise<Uint8Array> {
  if (!extensionPathSchema.safeParse(path).success)
    throw new Error('EXTENSION_UNSAFE_PATH')
  const absolute = join(root, path)
  if ((await lstat(absolute)).isSymbolicLink())
    throw new Error('EXTENSION_UNSAFE_PATH')
  const actual = await realpath(absolute)
  const child = relative(await realpath(root), actual)
  if (!child || child.startsWith('..') || child.startsWith('/') || child.includes(':'))
    throw new Error('EXTENSION_UNSAFE_PATH')
  const bytes = await readExtensionFile(actual)
  if (sha256(bytes) !== hash)
    throw new Error('EXTENSION_PACKAGE_CHANGED')
  return bytes
}

export async function readExtensionJson(path: string, limit = EXTENSION_FILE_LIMIT): Promise<unknown> {
  return JSON.parse((await readExtensionFile(path, limit)).toString('utf8')) as unknown
}
