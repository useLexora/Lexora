import type { SyncAdapter } from './SyncAdapter'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export async function probeSyncConnection(adapter: SyncAdapter, signal: AbortSignal): Promise<void> {
  await adapter.test(signal)
  await adapter.prepare(signal)
  await adapter.list(signal)
  const bytes = randomBytes(32)
  const key = `objects/${randomUUID()}-${createHash('sha256').update(bytes).digest('hex')}`
  let failure: unknown
  try {
    await adapter.write(key, bytes, signal)
    const downloaded = await adapter.read(key, bytes.length, signal)
    if (!downloaded || !Buffer.from(downloaded).equals(bytes))
      throw new Error('SYNC_CHECKSUM_FAILED')
  }
  catch (error) {
    failure = error
  }
  if (!(failure instanceof Error && failure.message === 'SYNC_REMOTE_CONFLICT')) {
    try {
      await adapter.remove(key, AbortSignal.timeout(10_000))
    }
    catch {
      failure ??= new Error('SYNC_TEST_CLEANUP_FAILED')
    }
  }
  if (failure)
    throw failure
}
