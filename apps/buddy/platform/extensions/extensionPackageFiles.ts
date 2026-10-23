import { Buffer } from 'node:buffer'
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { EXTENSION_EXPANDED_LIMIT, EXTENSION_FILE_LIMIT, EXTENSION_PACKAGE_ENTRY_LIMIT, validateExtensionFileCounts } from '../../shared/extensions/extensionPackageBudget.ts'
import { extensionPathSchema } from '../../shared/extensions/extensionPath.ts'

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
  const names = new Set<string>()
  let total = 0
  let count = 0
  async function walk(folder: string) {
    const entries = await readdir(folder, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(folder, entry.name)
      const name = relative(root, path).replaceAll('\\', '/')
      if (++count > EXTENSION_PACKAGE_ENTRY_LIMIT)
        throw new Error('EXTENSION_PACKAGE_LIMIT')
      if (entry.isSymbolicLink() || !extensionPathSchema.safeParse(name).success || names.has(name.toLowerCase()))
        throw new Error('EXTENSION_UNSAFE_PATH')
      names.add(name.toLowerCase())
      if (entry.isDirectory()) {
        await walk(path)
      }
      else if (entry.isFile()) {
        validateExtensionFileCounts([...files.keys(), name])
        const bytes = await readExtensionFile(path, Math.min(EXTENSION_FILE_LIMIT, EXTENSION_EXPANDED_LIMIT - total))
        total += bytes.byteLength
        files.set(name, bytes)
      }
      else { throw new Error('EXTENSION_UNSAFE_PATH') }
    }
  }
  await walk(root)
  return files
}
