import type { ExtensionTaskCleanup, ExtensionTaskCleanupDelete, ExtensionTaskCleanupProgress, ExtensionTaskCleanupResult } from '../../shared/extensions/extensionTaskCleanup'
import { extensionError } from '../../shared/extensions/extensionApi'
import { extensionTaskCleanupPageSchema, extensionTaskCleanupResultSchema } from '../../shared/extensions/extensionTaskCleanup'

export interface ExtensionTaskCleanupBatchResult {
  status: 'cancelled' | 'completed'
  results: (ExtensionTaskCleanupDelete & ExtensionTaskCleanupResult)[]
  summary: ExtensionTaskCleanupProgress
}

export type { ExtensionTaskCleanupProgress } from '../../shared/extensions/extensionTaskCleanup'

export async function runExtensionTaskCleanupBatch(options: {
  cleanup: ExtensionTaskCleanup
  confirm: (count: number, assertCurrent: () => void) => Promise<boolean>
  assertCurrent: () => void
  progress?: (progress: ExtensionTaskCleanupProgress) => unknown
}): Promise<ExtensionTaskCleanupBatchResult> {
  const progress: ExtensionTaskCleanupProgress = { phase: 'scanning', total: null, processed: 0, deleted: 0, pending: 0, failed: 0, skipped: 0, errorCode: null }
  const publish = async () => {
    try {
      await options.progress?.({ ...progress })
    }
    catch {}
  }
  const targets: ExtensionTaskCleanupDelete[] = []
  const results: ExtensionTaskCleanupBatchResult['results'] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  await publish()
  try {
    let cursor: string | undefined
    do {
      options.assertCurrent()
      const page = extensionTaskCleanupPageSchema.parse(await options.cleanup.list({ limit: 100, ...(cursor ? { cursor } : {}) }))
      options.assertCurrent()
      for (const item of page.items) {
        if (ids.has(item.conversationId))
          throw new Error('EXTENSION_TASK_CLEANUP_SOURCE_CHANGED')
        ids.add(item.conversationId)
        if (!item.canDelete) {
          progress.skipped++
          continue
        }
        targets.push(Object.freeze({ conversationId: item.conversationId, expectedRevision: item.expectedRevision }))
      }
      await publish()
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor))
        throw new Error('EXTENSION_TASK_CLEANUP_SOURCE_CHANGED')
      if (cursor)
        cursors.add(cursor)
    } while (cursor)
    progress.total = targets.length
    if (targets.length) {
      progress.phase = 'confirming'
      await publish()
      options.assertCurrent()
      const confirmed = await options.confirm(targets.length, options.assertCurrent)
      options.assertCurrent()
      if (!confirmed) {
        progress.phase = 'cancelled'
        await publish()
        return { status: 'cancelled', results, summary: { ...progress } }
      }
      progress.phase = 'running'
      await publish()
      for (const target of targets) {
        options.assertCurrent()
        let result: ExtensionTaskCleanupResult
        try {
          result = extensionTaskCleanupResultSchema.parse(await options.cleanup.delete(target))
        }
        catch (error) {
          result = { status: 'failed', errorCode: extensionError(error) }
        }
        results.push({ ...target, ...result })
        progress.processed++
        progress[result.status]++
        if (result.status === 'failed')
          progress.errorCode ??= result.errorCode ?? 'EXTENSION_TASK_CLEANUP_FAILED'
        await publish()
        options.assertCurrent()
      }
    }
    progress.phase = progress.failed ? 'failed' : 'completed'
    await publish()
    return { status: 'completed', results, summary: { ...progress } }
  }
  catch (error) {
    progress.phase = 'failed'
    progress.errorCode = extensionError(error)
    await publish()
    return { status: 'completed', results, summary: { ...progress } }
  }
}
