import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { PrivateNetworkError } from '../../../shared/privateNetwork/pairing'

const blockBytes = 1024 * 1024
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export const snapshotIdentity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`

export interface SnapshotProof {
  sha256: string
  blocks: string[]
}

async function readBlock(file: FileHandle, position: number, size: number) {
  const block = Buffer.allocUnsafe(Math.min(blockBytes, size - position))
  let offset = 0
  while (offset < block.length) {
    const { bytesRead } = await file.read(block, offset, block.length - offset, position + offset)
    if (!bytesRead)
      throw new PrivateNetworkError('VERSION_CHANGED')
    offset += bytesRead
  }
  return block
}

export async function indexSnapshot(input: FileHandle, size: number, check: () => void, output?: FileHandle): Promise<SnapshotProof> {
  const hash = createHash('sha256')
  const blocks: string[] = []
  for (let position = 0; position < size; position += blockBytes) {
    check()
    const block = await readBlock(input, position, size)
    hash.update(block)
    blocks.push(digest(block))
    if (output)
      await output.writeFile(block)
  }
  return { sha256: hash.digest('hex'), blocks }
}

export async function* verifiedRange(input: FileHandle, size: number, blocks: readonly string[], start: number, end: number, check: () => void, corrupt: () => never) {
  for (let i = Math.floor(start / blockBytes); i <= Math.floor(end / blockBytes); i++) {
    check()
    const position = i * blockBytes
    const block = await readBlock(input, position, size)
    if (digest(block) !== blocks[i])
      corrupt()
    yield block.subarray(Math.max(0, start - position), Math.min(block.length, end + 1 - position))
  }
}

export async function snapshotFile(source: string, target: string, size: number, check: () => void) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await input.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(size))
      throw new PrivateNetworkError('VERSION_CHANGED')
    const output = await open(target, 'wx', 0o600)
    try {
      const proof = await indexSnapshot(input, size, check, output)
      if (snapshotIdentity(before) !== snapshotIdentity(await input.stat({ bigint: true })) || snapshotIdentity(before) !== snapshotIdentity(await stat(source, { bigint: true })))
        throw new PrivateNetworkError('VERSION_CHANGED')
      await output.sync()
      return proof
    }
    finally { await output.close() }
  }
  finally { await input.close() }
}
