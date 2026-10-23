import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate/browser'
import { extensionPathSchema } from '../../shared/extensions/extensionManifest'
import { EXTENSION_EXPANDED_LIMIT, EXTENSION_FILE_LIMIT, EXTENSION_PACKAGE_ENTRY_LIMIT, validateExtensionArchiveSize, validateExtensionFileCounts, validateExtensionFiles } from '../../shared/extensions/extensionPackageBudget.ts'
import { fileStorage } from '../filesystem/fileStorage'

import { readExtensionFile } from './extensionPackageFiles.ts'

export { EXTENSION_ARCHIVE_LIMIT, EXTENSION_FILE_LIMIT, validateExtensionFiles } from '../../shared/extensions/extensionPackageBudget.ts'
export { readExtensionDirectory, readExtensionFile } from './extensionPackageFiles.ts'
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

export function unpackExtension(bytes: Uint8Array): Map<string, Uint8Array> {
  validateExtensionArchiveSize(bytes.byteLength)
  const files = new Map<string, Uint8Array>()
  const names = new Set<string>()
  let failure: Error | undefined
  let total = 0
  let completed = 0
  let count = 0
  let declaredTotal = 0
  const paths: string[] = []
  const unzip = new Unzip((file) => {
    count++
    const name = file.name.endsWith('/') ? file.name.slice(0, -1) : file.name
    const normalized = name.toLowerCase()
    if (count > EXTENSION_PACKAGE_ENTRY_LIMIT || !extensionPathSchema.safeParse(name).success || names.has(normalized) || (file.originalSize ?? 0) > EXTENSION_FILE_LIMIT) {
      failure = new Error('EXTENSION_UNSAFE_PACKAGE')
      file.terminate()
      return
    }
    names.add(normalized)
    declaredTotal += file.originalSize ?? 0
    if (!file.name.endsWith('/'))
      paths.push(name)
    try {
      validateExtensionFileCounts(paths)
      if (declaredTotal > EXTENSION_EXPANDED_LIMIT)
        throw new Error('EXTENSION_PACKAGE_LIMIT')
    }
    catch {
      failure = new Error('EXTENSION_PACKAGE_LIMIT')
      file.terminate()
      return
    }
    const chunks: Uint8Array[] = []
    const output = file.originalSize === undefined ? undefined : new Uint8Array(file.originalSize)
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (error)
        failure = new Error('EXTENSION_INVALID_ARCHIVE')
      if (failure)
        return file.terminate()
      size += chunk.byteLength
      total += chunk.byteLength
      if (size > EXTENSION_FILE_LIMIT || total > EXTENSION_EXPANDED_LIMIT || (output && size > output.byteLength)) {
        failure = new Error('EXTENSION_PACKAGE_LIMIT')
        file.terminate()
        return
      }
      if (output)
        output.set(chunk, size - chunk.byteLength)
      else
        chunks.push(chunk)
      if (final) {
        if (output && size !== output.byteLength) {
          failure = new Error('EXTENSION_INVALID_ARCHIVE')
          return
        }
        completed++
        if (!file.name.endsWith('/'))
          files.set(name, output ?? Buffer.concat(chunks, size))
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
