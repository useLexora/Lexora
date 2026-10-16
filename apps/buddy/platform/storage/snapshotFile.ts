import type { SnapshotFile } from '../../shared/storage/snapshot'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { SNAPSHOT_CHUNK_BYTES } from '../../shared/storage/snapshot'
import { storageError } from './storageFiles'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function* fileChunks(path: string, sizes: number[], signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const size = sizes.reduce((total, length) => total + length, 0)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== size)
    throw storageError('SNAPSHOT_FILE_CHANGED')
  const file = await open(path, 'r')
  try {
    let offset = 0
    for (const length of sizes) {
      signal.throwIfAborted()
      const bytes = new Uint8Array(length)
      let filled = 0
      while (filled < bytes.length) {
        const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, offset + filled)
        if (!bytesRead)
          throw storageError('SNAPSHOT_FILE_CHANGED')
        filled += bytesRead
      }
      offset += filled
      yield bytes
    }
    const after = await file.stat()
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs)
      throw storageError('SNAPSHOT_FILE_CHANGED')
  }
  finally { await file.close() }
}

export async function packSnapshotFile(path: string, size: number, executable: boolean, signal: AbortSignal): Promise<Pick<SnapshotFile, 'size' | 'hash' | 'chunks' | 'compression'>> {
  const temporary = `${path}.packing-${randomUUID()}`
  const hash = createHash('sha256')
  let length = 0
  try {
    await pipeline(createReadStream(path), new Transform({
      transform(bytes, _encoding, callback) {
        length += bytes.length
        hash.update(bytes)
        callback(length > size ? storageError('SNAPSHOT_FILE_CHANGED') : null, bytes)
      },
    }), createGzip({ level: 6 }), createWriteStream(temporary, { flags: 'wx', mode: executable ? 0o700 : 0o600 }), { signal })
    if (length !== size)
      throw storageError('SNAPSHOT_FILE_CHANGED')
    const compressedSize = (await lstat(temporary)).size
    const compression = compressedSize < size ? 'gzip' as const : undefined
    if (compression)
      await rename(temporary, path)
    const chunks: SnapshotFile['chunks'] = []
    const storedSize = compression ? compressedSize : size
    const sizes = Array.from({ length: Math.ceil(storedSize / SNAPSHOT_CHUNK_BYTES) }, (_, index) => Math.min(SNAPSHOT_CHUNK_BYTES, storedSize - index * SNAPSHOT_CHUNK_BYTES))
    for await (const bytes of fileChunks(path, sizes, signal))
      chunks.push({ hash: digest(bytes), size: bytes.length })
    await chmod(path, executable ? 0o700 : 0o600)
    const file = await open(path, 'r+')
    try {
      await file.sync()
    }
    finally { await file.close() }
    return { size, hash: hash.digest('hex'), chunks, ...(compression ? { compression } : {}) }
  }
  finally { await rm(temporary, { force: true }) }
}

export async function* readSnapshotChunks(directory: string, entry: SnapshotFile, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let index = 0
  for await (const bytes of fileChunks(join(directory, 'files', entry.path), entry.chunks.map(chunk => chunk.size), signal)) {
    const chunk = entry.chunks[index++]
    if (!chunk || bytes.length !== chunk.size || digest(bytes) !== chunk.hash)
      throw storageError('SNAPSHOT_CHECKSUM_FAILED')
    yield bytes
  }
  if (index !== entry.chunks.length)
    throw storageError('SNAPSHOT_CHECKSUM_FAILED')
}

export async function consumeSnapshotFile(directory: string, entry: SnapshotFile, signal: AbortSignal, consume: (bytes: Uint8Array) => void | Promise<void>): Promise<void> {
  const hash = createHash('sha256')
  let length = 0
  const accept = async (source: AsyncIterable<Uint8Array>) => {
    for await (const bytes of source) {
      signal.throwIfAborted()
      length += bytes.length
      if (length > entry.size)
        throw storageError('SNAPSHOT_CHECKSUM_FAILED')
      hash.update(bytes)
      await consume(bytes)
    }
  }
  const source = Readable.from(readSnapshotChunks(directory, entry, signal))
  try {
    if (entry.compression)
      await pipeline(source, createGunzip(), accept, { signal })
    else
      await pipeline(source, accept, { signal })
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('Z_'))
      throw storageError('SNAPSHOT_CHECKSUM_FAILED')
    throw error
  }
  if (length !== entry.size || hash.digest('hex') !== entry.hash)
    throw storageError('SNAPSHOT_CHECKSUM_FAILED')
}
