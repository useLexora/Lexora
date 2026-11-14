import type { BuddyResourceQuote } from '../../../shared/conversation/buddyUserContent'
import type { TrustedProductContext } from '../../../shared/productProtocol/identity'
import type { ProductMethod } from '../../../shared/productProtocol/methods'
import type { BuddyServiceCommands } from '../BuddyService'
import type { CommandResolution } from '../commands/CommandAdmissionService'
import type { ProductRequestHandler } from './ProductConnection'
import { conversationArchiveQuerySchema } from '../../../shared/conversation/conversationArchiveApi'
import { assertProductContentActions, productEditableContentSchema, restoreProductContent } from '../../../shared/productProtocol/content'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { productByteLength } from '../../../shared/productProtocol/limits'
import { productCommandIntents } from '../../../shared/productProtocol/methods'
import { decodeSafeProductRevision, encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { CommandAdmissionError } from '../commands/CommandAdmissionError'
import { COMMAND_FINGERPRINT_VERSION, fingerprintCommandIntent, fingerprintProductCommandIntent, PRODUCT_COMMAND_FINGERPRINT_VERSION, productCommandFingerprint } from '../commands/commandIntent'
import { assertSameCommand } from '../storage/CommandCommitter'
import { projectCommandReceipt } from './projectCommandReceipt'

export function createProductCommandHandlers(options: {
  commands: BuddyServiceCommands
  assertOwner: (context: Readonly<TrustedProductContext>) => void
  resolveQuote: (resourceId: string, context: Readonly<TrustedProductContext>) => BuddyResourceQuote
  allowedActions: ReadonlySet<string>
  allowLocalEffects?: boolean
  assertExecutionAvailable?: () => void
  hasReview?: (approvalId: string, version: string) => boolean
}): Partial<Record<ProductMethod, ProductRequestHandler>> {
  const { commands } = options
  const handlers: Partial<Record<ProductMethod, ProductRequestHandler>> = {
    'conversations.listArchived': { handle: (input, context) => {
      options.assertOwner(context)
      const page = commands.metadata.listArchived(conversationArchiveQuerySchema.parse({ ...input as Record<string, unknown>, cursor: (input as { cursor?: string | null }).cursor ?? undefined }))
      return { ...page, items: page.items.map(({ metadataRevision, ...item }) => ({ ...item, revision: encodeProductRevision(metadataRevision!) })) }
    } },
    'conversations.getArchivePolicy': { handle: (_input, context) => {
      options.assertOwner(context)
      return commands.metadata.getArchivePolicy()
    } },
    'uploads.get': { handle: (input, context) => {
      options.assertOwner(context)
      return commands.uploads.get((input as { uploadId: string }).uploadId)
    } },
    'commands.get': { handle: (input, context) => {
      options.assertOwner(context)
      const lookup = commands.admission.lookup(input)
      return lookup.lookup === 'decided' ? { lookup: 'decided', receipt: projectCommandReceipt(lookup.receipt) } : lookup
    } },
  }
  for (const method of Object.keys(productCommandIntents) as (keyof typeof productCommandIntents)[]) {
    handlers[method] = { handle: async (input, context, client) => {
      options.assertOwner(context)
      const envelope = input as { dataGeneration: string, commandId: string, expectedServiceInstanceId: string, intent: Record<string, unknown> }
      const previous = commands.admission.lookup({ dataGeneration: envelope.dataGeneration, commandId: envelope.commandId })
      const fingerprint = fingerprintProductCommandIntent(method, envelope.intent)
      if (previous.lookup === 'decided' && previous.receipt.fingerprintVersion !== COMMAND_FINGERPRINT_VERSION) {
        if (previous.receipt.fingerprintVersion !== PRODUCT_COMMAND_FINGERPRINT_VERSION)
          throw new ProductProtocolError('COMMAND_FINGERPRINT_UNSUPPORTED')
        try {
          assertSameCommand(previous.receipt, { method, fingerprint: fingerprint.fingerprint, fingerprintVersion: fingerprint.version })
        }
        catch (error) {
          if (error instanceof CommandAdmissionError)
            throw new ProductProtocolError(error.code)
          throw error
        }
        return { receipt: projectCommandReceipt(previous.receipt) }
      }
      const intent = { ...envelope.intent }
      for (const key of ['expectedRevision', 'expectedSourceRevision', 'expectedSlotRevision', 'expectedRunGeneration', 'expectedTitleRevision', 'expectedAssignmentRevision', 'readRevision']) {
        if (typeof intent[key] === 'string') {
          try {
            intent[key] = decodeSafeProductRevision(intent[key])
          }
          catch { throw new ProductProtocolError('INVALID_PARAMS') }
        }
      }
      if (intent.expectedActiveRun && typeof intent.expectedActiveRun === 'object') {
        const active = intent.expectedActiveRun as { runId: string, generation: string, modelSelection: unknown }
        try {
          intent.expectedActiveRun = { ...active, generation: decodeSafeProductRevision(active.generation) }
        }
        catch { throw new ProductProtocolError('INVALID_PARAMS') }
      }
      if (method === 'composerDrafts.save' || method === 'composerDrafts.open') {
        if (previous.lookup === 'not_found' && !client.supportedContentKinds.includes('buddy-user-content-v1'))
          throw new ProductProtocolError('CONTENT_UNSUPPORTED')
        const contentKey = method === 'composerDrafts.open' ? 'initialContent' : 'content'
        const content = productEditableContentSchema.parse(intent[contentKey])
        if (previous.lookup === 'not_found')
          assertProductContentActions(content, options.allowedActions)
        intent[contentKey] = restoreProductContent(content, resourceId => options.resolveQuote(resourceId, context))
      }
      if (method === 'composerDrafts.copy' && intent.recoveredInput) {
        const recovered = intent.recoveredInput as Record<string, unknown>
        const content = productEditableContentSchema.parse(recovered.content)
        if (previous.lookup === 'not_found') {
          if (!client.supportedContentKinds.includes('buddy-user-content-v1'))
            throw new ProductProtocolError('CONTENT_UNSUPPORTED')
          assertProductContentActions(content, options.allowedActions)
        }
        intent.recoveredInput = { ...recovered, content: restoreProductContent(content, resourceId => options.resolveQuote(resourceId, context)) }
      }
      if (method === 'chat.submitInput') {
        const snapshot = intent.input as Record<string, unknown>
        const content = productEditableContentSchema.parse(snapshot.content)
        if (previous.lookup === 'not_found') {
          if (!client.supportedContentKinds.includes('buddy-user-content-v1'))
            throw new ProductProtocolError('CONTENT_UNSUPPORTED')
          assertProductContentActions(content, options.allowedActions)
        }
        intent.input = { ...snapshot, content: restoreProductContent(content, resourceId => options.resolveQuote(resourceId, context)) }
      }
      if (previous.lookup === 'decided') {
        try {
          const fingerprint = fingerprintCommandIntent(method, intent)
          assertSameCommand(previous.receipt, { method, fingerprint: fingerprint.fingerprint, fingerprintVersion: fingerprint.version })
        }
        catch (error) {
          if (error instanceof CommandAdmissionError)
            throw new ProductProtocolError(error.code)
          throw error
        }
        return { receipt: projectCommandReceipt(previous.receipt) }
      }
      if (previous.lookup === 'not_found' && ['chat.submitInput', 'chat.startTurn', 'chat.editUserMessage', 'chat.regenerateAssistant', 'chat.executeCommand', 'chat.queue.enqueue', 'chat.queue.continue', 'chat.queue.steer'].includes(method))
        options.assertExecutionAvailable?.()
      if (previous.lookup === 'not_found' && method === 'approvals.resolve' && intent.decision !== 'denied') {
        const approval = commands.approvals.getReview(String(intent.approvalId))
        if (!approval || !approval.review?.complete || !client.supportedReviewKinds.includes(approval.kind) || (!options.allowLocalEffects && productByteLength(JSON.stringify(approval.review.body, null, 2)) > 131_072 && !options.hasReview?.(String(intent.approvalId), approval.review.reviewVersion)))
          throw new ProductProtocolError('CONTENT_UNSUPPORTED')
        if (approval.review.persistentEffect && !options.allowLocalEffects)
          throw new ProductProtocolError('NOT_AUTHORIZED')
      }
      const submission = { ...envelope, intent, [productCommandFingerprint]: fingerprint }
      let result: CommandResolution
      try {
        switch (method) {
          case 'desktop.open':
            result = await commands.desktop.execute(submission)
            break
          case 'chat.submitInput': case 'chat.startTurn': case 'chat.editUserMessage': case 'chat.regenerateAssistant': case 'chat.executeCommand': case 'chat.queue.enqueue':
            result = await commands.input.execute(method, submission)
            break
          case 'chat.queue.continue': case 'chat.queue.cancel': case 'chat.queue.steer': case 'chat.cancel':
            result = await commands.control.execute(method, submission)
            break
          case 'composerDrafts.open': case 'composerDrafts.save': case 'composerDrafts.discard': case 'composerDrafts.copy':
            result = await commands.drafts.execute(method, submission)
            break
          case 'uploads.stage': case 'uploads.create': case 'uploads.complete': case 'uploads.cancel': case 'uploads.adopt':
            result = await commands.uploads.execute(method, submission)
            break
          case 'questions.answer': case 'questions.cancel': case 'questions.retry':
            result = await commands.questions.execute(method, submission)
            break
          case 'approvals.resolve':
            result = await commands.approvals.resolveCommand(submission)
            break
          default:
            result = await commands.metadata.execute(method, submission)
        }
      }
      catch (error) {
        if (error instanceof CommandAdmissionError)
          throw new ProductProtocolError(error.code)
        throw error
      }
      return { receipt: projectCommandReceipt(result.receipt) }
    } }
  }
  return handlers
}
