import type { ExtensionInvocationScope } from '../plugins/extensionAgentHandlers'
import type { ExtensionReferenceRepository } from '../storage/extensionReferenceRepository'
import type { ExtensionTaskSession } from './ExtensionTaskContext'
import { createHash } from 'node:crypto'
import { readTextMaterialPage } from '../../../shared/conversation/textMaterialRead'
import { extensionAgentHandler } from '../plugins/extensionAgentHandlers'

export function createExtensionReferenceCapabilities(history: ExtensionReferenceRepository, task: ExtensionTaskSession, scope: ExtensionInvocationScope) {
  const cutoff = !scope.action && scope.runId ? history.activeScope(scope.conversationId, scope.runId) : null
  const read = (referenceId?: string, sourceMessageId?: string) => {
    task.assertCurrent()
    if (!cutoff)
      throw new Error('EXTENSION_REFERENCE_UNAVAILABLE')
    return history.references(cutoff, scope.extensionId, referenceId, sourceMessageId)
  }
  return {
    'references.list': extensionAgentHandler('references.list', () => {
      const references = read()
      const items: { referenceId: string, sourceMessageId: string, title: string, excerpt: string }[] = []
      let bytes = 0
      for (const { quote, sourceMessageId } of references.slice(0, 100)) {
        const item = { referenceId: quote.id, sourceMessageId, title: quote.source.title, excerpt: readTextMaterialPage(quote.text, { limit: 512 }).text }
        bytes += new TextEncoder().encode(JSON.stringify(item)).byteLength
        if (bytes > 240_000)
          break
        items.push(item)
      }
      return { items, truncated: references.length > items.length }
    }),
    'references.resolve': extensionAgentHandler('references.resolve', ({ referenceId, sourceMessageId, offset = 0, limit = 32768 }) => {
      const references = read(referenceId, sourceMessageId)
      if (references.length > 1)
        throw new Error('EXTENSION_REFERENCE_AMBIGUOUS: pass sourceMessageId from references.list')
      const snapshot = references[0]
      if (!snapshot)
        throw new Error('EXTENSION_REFERENCE_UNAVAILABLE')
      const { quote } = snapshot
      if (offset > quote.text.length)
        throw new Error('EXTENSION_REFERENCE_OFFSET_OUT_OF_RANGE')
      const page = readTextMaterialPage(quote.text, { offset, limit })
      return { referenceId: quote.id, sourceMessageId: snapshot.sourceMessageId, title: quote.source.title, text: page.text, textLength: quote.text.length, textDigest: createHash('sha256').update(quote.text, 'utf8').digest('hex'), offset: page.offset, nextOffset: page.nextOffset, locator: quote.locator ?? null, scope: { taskId: task.conversationId, branchId: task.branchId } }
    }),
  }
}
