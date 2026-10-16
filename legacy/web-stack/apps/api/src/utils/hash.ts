import type { BinaryLike } from 'node:crypto'
import { createHash } from 'node:crypto'

export function sha256Hex(value: BinaryLike): string {
  return createHash('sha256').update(value).digest('hex')
}
