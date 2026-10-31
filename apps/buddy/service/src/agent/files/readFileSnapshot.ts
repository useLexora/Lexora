import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { detectReadingImageMime } from '../../images/detectReadingImageMime'
import { decodeReadText, detectBinaryReadFormat } from './readFileContent'

export type ReadFileSnapshot
  = { kind: 'omitted', format: string, sizeBytes: number }
    | { kind: 'text', text: string }
    | { kind: 'image', bytes: Buffer, mimeType: string }

export async function readFileSnapshot(path: string, signal?: AbortSignal): Promise<ReadFileSnapshot> {
  signal?.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  let bytes: Buffer
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile())
      throw new Error('read requires a regular file. Use a directory listing tool for directories; devices and pipes cannot be read.')
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const format = detectBinaryReadFormat(header.subarray(0, bytesRead))
    if (format || metadata.size > 32 * 1024 * 1024)
      return { kind: 'omitted', format: format ?? 'File exceeding the 32 MiB read memory limit', sizeBytes: metadata.size }
    bytes = Buffer.alloc(metadata.size)
    let position = 0
    while (position < bytes.length) {
      signal?.throwIfAborted()
      const read = await handle.read(bytes, position, Math.min(64 * 1024, bytes.length - position), position)
      if (!read.bytesRead)
        break
      position += read.bytesRead
    }
    bytes = bytes.subarray(0, position)
  }
  finally {
    await handle.close()
  }
  signal?.throwIfAborted()
  const format = detectBinaryReadFormat(bytes)
  if (format)
    return { kind: 'omitted', format, sizeBytes: bytes.length }
  const mimeType = detectReadingImageMime(bytes)
  return mimeType ? { kind: 'image', bytes, mimeType } : { kind: 'text', text: decodeReadText(bytes) }
}
