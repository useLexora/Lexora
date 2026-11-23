import type { z } from 'zod'
import type { ProductCommandMethod } from '../../../shared/productProtocol/methods'
import type { productCommandReceiptSchema } from '../../../shared/productProtocol/receipts'
import type { ProductRecoveryItem } from '../../../shared/runtime/productRecovery'
import type { DesktopRuntimeGateway } from '../local-chat/registrar'
import type { DesktopNotificationInbox } from '../notifications/DesktopNotificationInbox'
import type { DesktopCommandOutcome } from './DesktopProductCommands'
import type { ProductOutboxRecord, ProductRecoveryInput } from './ProductOutboxStore'
import { randomUUID } from 'node:crypto'
import { buddyComposerDraftSchema } from '../../../shared/conversation/composerDraft'
import { conversationRequestSchemas, conversationResponseSchemas } from '../../../shared/conversation/conversationApi'
import { conversationArchivePolicySchema } from '../../../shared/conversation/conversationArchiveApi'
import { APPROVAL_REVIEW_KINDS } from '../../../shared/permissions/approvalReviewPayload'
import { PRODUCT_PROTOCOL_VERSION } from '../../../shared/productProtocol/identity'
import { productCommandIntents } from '../../../shared/productProtocol/methods'
import { productConversationArchivePageSchema, productDraftSchema } from '../../../shared/productProtocol/queries'
import { decodeSafeProductRevision, encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { desktopProductContentProject } from '../../../shared/productProtocol/transport'
import { userQuestionRpc } from '../../../shared/questions/userQuestionApi'
import { runsResponseSchemas } from '../../../shared/runs/runApi'
import { DesktopProductCommands } from './DesktopProductCommands'
import { DesktopTaskSynchronization } from './DesktopTaskSynchronization'
import { isProductOutboxOwner, productOutboxRecordId, ProductOutboxStore, productRecoveryDigest } from './ProductOutboxStore'
import { ProductRecoveryNotifications } from './ProductRecoveryNotifications'
import { findRecoveryReview, recoveryRecordIds, reviewProductRecoveries } from './ProductRecoveryReview'
import { ProductRpcClient } from './ProductRpcClient'

const turnMethods = new Set(['chat.startTurn', 'chat.editUserMessage', 'chat.regenerateAssistant', 'chat.executeCommand'])
const draftMethods = new Set(['composerDrafts.open', 'composerDrafts.save'])
const questionMethods = new Set(['questions.answer', 'questions.cancel', 'questions.retry'])
type Receipt = z.infer<typeof productCommandReceiptSchema>
type RequestOptions = NonNullable<Parameters<DesktopRuntimeGateway['request']>[2]>

export class ProductDesktopGateway implements DesktopRuntimeGateway {
  readonly #runtime: DesktopRuntimeGateway
  readonly #version: string
  readonly #commands: DesktopProductCommands
  readonly #stopState: () => void
  readonly #notifications = new Set<(notification: { method: string, params: unknown }) => void>()
  #synchronization: DesktopTaskSynchronization | null = null
  #client: Promise<ProductRpcClient> | null = null
  #current: ProductRpcClient | null = null
  readonly #delivering = new Set<{ client: ProductRpcClient, commandId: string }>()
  readonly #recoveryNotifications: ProductRecoveryNotifications
  #recoveryTail: Promise<unknown> = Promise.resolve()
  readonly #saving = new Set<Promise<unknown>>()
  #generation = 0
  #detach: (() => void) | null = null

  constructor(runtime: DesktopRuntimeGateway, directory: string, version: string, inbox: DesktopNotificationInbox, onNotificationError: (error: unknown) => void) {
    this.#runtime = runtime
    this.#version = version
    this.#commands = new DesktopProductCommands(new ProductOutboxStore(directory))
    this.#recoveryNotifications = new ProductRecoveryNotifications(inbox, () => this.#serialRecovery(async () => (await this.#reviews()).map(review => review.item)), onNotificationError)
    const onStateChange = (state: unknown) => {
      if (state && typeof state === 'object' && 'status' in state && state.status === 'ready')
        void this.#recoveryNotifications.reconcile()
      else
        this.#reset()
    }
    this.#stopState = runtime.onStateChange(onStateChange)
    onStateChange(runtime.state)
  }

  get state(): unknown {
    return this.#runtime.state
  }

  onNotification: DesktopRuntimeGateway['onNotification'] = (listener) => {
    const stop = this.#runtime.onNotification(listener)
    this.#notifications.add(listener)
    return () => {
      stop()
      this.#notifications.delete(listener)
    }
  }

  onStateChange: DesktopRuntimeGateway['onStateChange'] = listener => this.#runtime.onStateChange(listener)
  restart: DesktopRuntimeGateway['restart'] = () => this.#runtime.restart()

  async request(method: string, params: unknown, options?: RequestOptions): Promise<unknown> {
    const result = this.#request(method, params, options)
    if (method === 'composerDrafts.save') {
      this.#saving.add(result)
      try {
        return await result
      }
      finally {
        this.#saving.delete(result)
      }
    }
    return result
  }

  async #request(method: string, params: unknown, options?: RequestOptions, requiredClient?: ProductRpcClient): Promise<unknown> {
    if (method === 'conversations.listArchived' || method === 'conversations.getArchivePolicy') {
      const client = await this.#connect()
      const result = await client.request(method, params)
      if (this.#current !== client)
        throw gatewayError('COMMAND_RESULT_UNKNOWN')
      if (method === 'conversations.getArchivePolicy')
        return conversationArchivePolicySchema.parse(result)
      const page = productConversationArchivePageSchema.parse(result)
      return { ...page, items: page.items.map(({ revision, ...item }) => ({ ...item, metadataRevision: decodeSafeProductRevision(revision) })) }
    }
    const productMethod = method === 'approvals.approve' || method === 'approvals.deny' ? 'approvals.resolve' : method
    if (!Object.hasOwn(productCommandIntents, productMethod))
      return this.#runtime.request(method, params, options)
    const client = requiredClient ?? await this.#connect()
    this.#assertClient(client)
    const input = objectInput(params)
    const intent = { ...input }
    const commandId = !questionMethods.has(method) && typeof intent.requestId === 'string' ? intent.requestId : options?.requestId ?? randomUUID()
    if (!requiredClient && /^recovery-[a-f0-9]{64}$/.test(commandId))
      throw gatewayError('VALIDATION_FAILED')
    if (!questionMethods.has(method))
      delete intent.requestId
    if (method === 'composerDrafts.open') {
      const current = objectInput(await client.request('composerDrafts.find', { scope: input.scope }))
      if (current.draft) {
        if (requiredClient)
          throw gatewayError('DRAFT_CONFLICT')
        const draft = objectInput(current.draft)
        return this.#runtime.request('composerDrafts.get', { draftId: draft.draftId }, options)
      }
      intent.expectedSlotRevision = current.slotRevision
    }
    if (draftMethods.has(method)) {
      const field = method === 'composerDrafts.open' ? 'initialContent' : 'content'
      intent[field] = desktopProductContentProject.response.parse(await this.#runtime.request(desktopProductContentProject.method, { content: input[field] }, options)).content
    }
    if (method === 'composerDrafts.copy' && intent.recoveredInput) {
      const recovered = objectInput(intent.recoveredInput)
      intent.recoveredInput = { ...recovered, content: desktopProductContentProject.response.parse(await this.#runtime.request(desktopProductContentProject.method, { content: recovered.content }, options)).content }
    }
    if (productMethod === 'approvals.resolve') {
      const conditions = objectInput(input.conditions)
      intent.runId = conditions.runId
      intent.reviewVersion = conditions.reviewVersion
      intent.decision = method === 'approvals.deny' ? 'denied' : input.scope === 'once' ? 'approved' : input.scope === 'persistent' ? 'approved_persistently' : `approved_for_${input.scope}`
      delete intent.conditions
      delete intent.scope
    }
    const actualMethod = productMethod === 'chat.queue.steer' && intent.targetRunId === null ? 'chat.queue.continue' : productMethod
    if (actualMethod === 'chat.queue.continue') {
      delete intent.targetRunId
      delete intent.expectedRunGeneration
    }
    for (const key of ['expectedRevision', 'expectedSourceRevision', 'expectedSlotRevision', 'expectedRunGeneration', 'expectedTitleRevision', 'expectedAssignmentRevision', 'readRevision']) {
      if (typeof intent[key] === 'number')
        intent[key] = encodeProductRevision(intent[key])
    }
    if (intent.expectedActiveRun && typeof intent.expectedActiveRun === 'object') {
      const active = objectInput(intent.expectedActiveRun)
      intent.expectedActiveRun = { ...active, generation: encodeProductRevision(Number(active.generation)) }
    }
    const recovery = await this.#recoveryInput(method, input, client, commandId, options?.recoveryScope)
    this.#assertClient(client)
    const delivery = { client, commandId }
    this.#delivering.add(delivery)
    let outcome: DesktopCommandOutcome | undefined
    const finish = (needsReview: boolean) => {
      this.#delivering.delete(delivery)
      if (needsReview || method === 'composerDrafts.save')
        void this.#recoveryNotifications.reconcile()
      else if (outcome)
        this.#recoveryNotifications.withdraw(productOutboxRecordId(outcome.record))
    }
    try {
      outcome = await this.#commands.execute({ method: actualMethod as ProductCommandMethod, commandId, intent, recovery })
      if (outcome.state !== 'decided' || !outcome.record.receipt)
        throw gatewayError(outcome.state === 'trust_changed' ? 'AUTHENTICATION_REQUIRED' : 'COMMAND_RESULT_UNKNOWN')
      const receipt = outcome.record.receipt
      if (receipt.decision === 'rejected') {
        if (requiredClient)
          await this.#commands.outbox.archive(outcome.record)
        throw gatewayError(receipt.errorCode ?? 'LOCAL_CHAT_OPERATION_FAILED')
      }
      if (this.#current !== client)
        throw gatewayError('COMMAND_RESULT_UNKNOWN')
      const result = await this.#projectResult(method, input, receipt, options, Boolean(requiredClient))
      if (this.#current !== client)
        throw gatewayError('COMMAND_RESULT_UNKNOWN')
      void this.#commands.outbox.archive(outcome.record).then(() => finish(false), () => finish(true))
      return result
    }
    catch (error) {
      finish(true)
      throw error
    }
  }

  async getIdentity() {
    return (await this.#connect()).identity
  }

  #serialRecovery<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#recoveryTail.then(operation, operation)
    this.#recoveryTail = pending.catch(() => {})
    return pending
  }

  #assertClient(client: ProductRpcClient) {
    if (this.#current !== client)
      throw gatewayError('COMMAND_RESULT_UNKNOWN')
  }

  async #reviews() {
    const generation = this.#generation
    const assertCurrent = () => {
      if (generation !== this.#generation)
        throw gatewayError('COMMAND_RESULT_UNKNOWN')
    }
    const available = (record: ProductOutboxRecord) => !Array.from(this.#delivering).some(delivery =>
      delivery.commandId === record.commandId && isProductOutboxOwner(record.owner, delivery.client.identity))
    const records = (await this.#commands.outbox.list()).filter(record => available(record) && (record.method !== 'composerDrafts.save' || record.recovery?.scope))
    if (!records.length)
      return []
    const connection = await this.#connect().catch(() => null)
    assertCurrent()
    const outcomes = (await this.#commands.recover(records)).filter(outcome => available(outcome.record))
    return reviewProductRecoveries({ outcomes, connection, assertCurrent, outbox: this.#commands.outbox, readLocalDraft: draftId => this.#runtime.request('composerDrafts.get', { draftId }) })
  }

  recover(id?: string): Promise<ProductRecoveryItem[]> {
    return this.#serialRecovery(async () => {
      const reviews = await this.#reviews()
      this.#recoveryNotifications.replace(reviews.map(review => review.item))
      if (!id)
        return reviews.map(review => review.item)
      const review = findRecoveryReview(reviews, id)
      return review ? [review.item] : []
    })
  }

  acknowledgeRecovery(id: string): Promise<void> {
    const pending = [...this.#saving]
    return this.#serialRecovery(async () => {
      await Promise.allSettled(pending)
      const client = await this.#connect()
      const review = findRecoveryReview(await this.#reviews(), id)
      this.#assertClient(client)
      if (!review) {
        this.#recoveryNotifications.withdraw(id)
        return
      }
      if (!isProductOutboxOwner(review.record.owner, client.identity) || !['accepted', 'rejected', 'not_accepted'].includes(review.item.state))
        throw gatewayError('COMMAND_RESULT_UNKNOWN')
      await this.#commands.outbox.archive(review.record)
      this.#recoveryNotifications.withdraw(review.item.id)
    })
  }

  restoreRecovery(id: string): Promise<string> {
    const pending = [...this.#saving]
    return this.#serialRecovery(async () => {
      await Promise.allSettled(pending)
      return this.#restoreRecovery(id)
    })
  }

  async #restoreRecovery(id: string): Promise<string> {
    const client = await this.#connect()
    const review = findRecoveryReview(await this.#reviews(), id)
    this.#assertClient(client)
    if (!review)
      throw gatewayError('OBJECT_DELETED')
    const { record, item } = review
    const source = record.recovery
    if (!isProductOutboxOwner(record.owner, client.identity) || !item.canRestore || !source?.executionConfig)
      throw gatewayError('COMMAND_RESULT_UNKNOWN')
    const getDraft = async (draftId: string) => {
      const draft = productDraftSchema.nullable().parse(await client.request('composerDrafts.get', { draftId }))
      this.#assertClient(client)
      if (draft && (draft.draftId !== draftId || !draft.writable || draft.ownerDeviceId !== client.identity.deviceId))
        throw gatewayError('COMMAND_RESULT_UNKNOWN')
      return draft
    }
    let commandId = `recovery-${item.id}`
    for (const legacyId of recoveryRecordIds(record)) {
      let attempt = `recovery-${legacyId}`
      for (;;) {
        const previous = await this.#commands.outbox.read(outboxOwner(client), attempt)
        if (!previous)
          break
        const recovered = await this.#commands.reconcile(previous)
        this.#assertClient(client)
        if (!['composerDrafts.copy', 'composerDrafts.open'].includes(previous.method) || !['decided', 'not_accepted'].includes(recovered.state))
          throw gatewayError('COMMAND_RESULT_UNKNOWN')
        if (recovered.record.receipt?.decision === 'accepted') {
          const target = recovered.record.receipt.target.draftId
          if (!target || (previous.method === 'composerDrafts.copy' && recovered.record.receipt.target.sourceDraftId !== source.draftId)
            || (previous.method === 'composerDrafts.open' && target !== `recovered-${attempt.slice(9, 41)}`)) {
            throw gatewayError('COMMAND_RESULT_UNKNOWN')
          }
          const draft = await getDraft(target)
          if (draft) {
            if (draft.scope.kind !== 'task' || draft.scope.draftId !== target)
              throw gatewayError('COMMAND_RESULT_UNKNOWN')
            if (draft.revision === recovered.record.receipt.result.revision)
              return target
          }
        }
        await this.#commands.outbox.archive(recovered.record)
        // Never overwrite an edited copy. An explicit retry may create a new one.
        attempt = `recovery-${productRecoveryDigest({ previous: attempt })}`
      }
      if (legacyId === item.id)
        commandId = attempt
    }
    const current = await getDraft(source.draftId)
    const originalSpace = source.scope && 'spaceId' in source.scope ? source.scope.spaceId : null
    const spaceId = item.draftInput?.spaceId === undefined ? originalSpace : item.draftInput.spaceId
    let draftId: string
    if (current) {
      const draft = buddyComposerDraftSchema.parse(await this.#request('composerDrafts.copy', {
        sourceDraftId: source.draftId,
        expectedSourceRevision: current.revision,
        targetScope: { kind: 'task', spaceId },
        expectedSlotRevision: '0',
        recoveredInput: { content: source.content, executionConfig: source.executionConfig, modelSelection: source.modelSelection ?? null, participants: source.participants ?? null },
      }, { requestId: commandId }, client))
      draftId = draft.draftId
    }
    else {
      draftId = `recovered-${commandId.slice(9, 41)}`
      await this.#request('composerDrafts.open', {
        draftId,
        scope: { kind: 'task', draftId, spaceId },
        initialContent: source.content,
        initialExecutionConfig: source.executionConfig,
        initialModelSelection: source.modelSelection ?? null,
        ...(source.participants ? { initialParticipants: source.participants } : {}),
      }, { requestId: commandId }, client)
    }
    return draftId
  }

  async #recoveryInput(method: string, input: Record<string, unknown>, client: ProductRpcClient, commandId: string, recoveryScope?: RequestOptions['recoveryScope']): Promise<ProductRecoveryInput | undefined> {
    const existing = await this.#commands.outbox.read(outboxOwner(client), commandId)
    if (existing)
      return existing.recovery ?? undefined
    if (method === 'composerDrafts.open' || method === 'composerDrafts.save') {
      const opening = method === 'composerDrafts.open'
      const draft = buddyComposerDraftSchema.parse({
        draftId: input.draftId,
        content: input[opening ? 'initialContent' : 'content'],
        modelSelection: input[opening ? 'initialModelSelection' : 'modelSelection'],
        executionConfig: input[opening ? 'initialExecutionConfig' : 'executionConfig'],
        participants: input[opening ? 'initialParticipants' : 'participants'],
        scope: opening ? input.scope : recoveryScope,
        revision: input.expectedRevision ?? 0,
        updatedAt: new Date().toISOString(),
      })
      const { scope } = draft
      if (scope.kind === 'task' && scope.draftId !== draft.draftId)
        throw gatewayError('VALIDATION_FAILED')
      return { draftId: draft.draftId, scope, editSequence: String(draft.revision), content: draft.content, executionConfig: draft.executionConfig, modelSelection: draft.modelSelection, participants: draft.participants }
    }
    if (typeof input.draftId === 'string' && (turnMethods.has(method) || method === 'chat.queue.enqueue')) {
      const draft = buddyComposerDraftSchema.parse(await this.#runtime.request('composerDrafts.get', { draftId: input.draftId }))
      if (draft.revision === input.expectedRevision)
        return { draftId: draft.draftId, scope: draft.scope, editSequence: String(draft.revision), content: draft.content, executionConfig: draft.executionConfig, modelSelection: draft.modelSelection, participants: draft.participants }
    }
    return undefined
  }

  dispose(): void {
    this.#recoveryNotifications.dispose()
    this.#stopState()
    this.#reset(false)
  }

  #reset(withdraw = true): void {
    this.#generation += 1
    if (withdraw)
      this.#recoveryNotifications.reset()
    this.#synchronization?.close()
    this.#synchronization = null
    this.#detach?.()
    this.#detach = null
    this.#current?.close()
    this.#current = null
    this.#client = null
  }

  #connect(): Promise<ProductRpcClient> {
    if (this.#client)
      return this.#client
    const generation = this.#generation
    const client = new ProductRpcClient({
      send: frame => this.#runtime.request('product.exchange', { frame }).then(() => {}),
      subscribe: listener => this.#runtime.onNotification((notification) => {
        if (notification.method !== 'product.frame')
          return
        const value = notification.params
        if (value && typeof value === 'object' && 'frame' in value && typeof value.frame === 'string')
          listener(value.frame)
      }),
      close: () => {},
    })
    this.#current = client
    this.#client = client.initialize({ protocol: { major: PRODUCT_PROTOCOL_VERSION.major, minMinor: PRODUCT_PROTOCOL_VERSION.minor, maxMinor: PRODUCT_PROTOCOL_VERSION.minor }, client: { kind: 'desktop', version: this.#version }, supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [...APPROVAL_REVIEW_KINDS] }).then(() => {
      if (generation !== this.#generation) {
        client.close()
        throw gatewayError('RUNTIME_UNAVAILABLE')
      }
      this.#detach = this.#commands.attach(client)
      this.#synchronization = new DesktopTaskSynchronization(client, (notification) => {
        if (generation !== this.#generation)
          return
        for (const listener of this.#notifications) {
          try {
            listener(notification)
          }
          catch {}
        }
      })
      return client
    })
    return this.#client
  }

  async #projectResult(method: string, input: Record<string, unknown>, receipt: Receipt, options?: { timeoutMs?: number, requestId?: string }, restoring = false): Promise<unknown> {
    const read = (method: string, params: unknown) => this.#runtime.request(method, params, options)
    if (questionMethods.has(method)) {
      const questions = userQuestionRpc.list.response.parse(await read('questions.list', { conversationId: input.conversationId, branchId: input.branchId }))
      const question = questions.find(question => question.id === receipt.target.questionId)
      if (!question)
        throw gatewayError('OBJECT_DELETED')
      return question
    }
    if (turnMethods.has(method)) {
      const run = runsResponseSchemas.run.parse(await read('runs.get', { runId: receipt.target.runId }))
      let userMessage = null
      if (run.purpose === 'chat' && run.triggeringMessageId) {
        let cursor: string | null = null
        do {
          const page = conversationResponseSchemas.messagePage.parse(await read('conversations.listMessages', conversationRequestSchemas.conversationMessages.parse({ conversationId: run.conversationId, branchId: run.branchId, ...(cursor ? { cursor } : {}) })))
          userMessage = page.items.find(message => message.id === run.triggeringMessageId) ?? null
          cursor = page.nextCursor
        } while (!userMessage && cursor)
      }
      const draft = receipt.result.draftReceipt
      return { conversationId: run.conversationId, branchId: run.branchId, runId: run.id, run, userMessage, draftReceipt: draft ? { draftId: draft.draftId, sourceRevision: input.expectedRevision, committedRevision: decodeSafeProductRevision(draft.committedRevision) } : null }
    }
    if (draftMethods.has(method) || method === 'composerDrafts.copy') {
      const draft = buddyComposerDraftSchema.parse(await read('composerDrafts.get', { draftId: receipt.target.draftId }))
      if (draft.draftId !== receipt.target.draftId || (restoring && (draft.scope.kind !== 'task' || draft.scope.draftId !== draft.draftId))
        || ((method === 'composerDrafts.save' || restoring) && draft.revision !== decodeSafeProductRevision(receipt.result.revision!))) {
        throw gatewayError('DRAFT_CONFLICT')
      }
      return draft
    }
    if (method === 'composerDrafts.discard')
      return receipt.result.discarded === true
    if (method === 'chat.queue.enqueue') {
      const draft = receipt.result.draftReceipt!
      return { id: receipt.target.queueId, conversationId: receipt.target.conversationId, branchId: receipt.target.branchId, draftReceipt: { draftId: draft.draftId, sourceRevision: input.expectedRevision, committedRevision: decodeSafeProductRevision(draft.committedRevision) } }
    }
    if (method === 'chat.queue.cancel')
      return receipt.result.cancelled === true
    if (method === 'chat.queue.steer')
      return 'accepted'
    if (method === 'chat.cancel')
      return read('runs.get', { runId: receipt.target.runId })
    if (method === 'approvals.approve' || method === 'approvals.deny') {
      const approvals = await read('approvals.list', { runId: receipt.target.runId }) as Array<{ id: string }>
      const approval = approvals.find(approval => approval.id === receipt.target.approvalId)
      if (!approval)
        throw gatewayError('OBJECT_DELETED')
      return approval
    }
    if (method === 'conversations.delete')
      return true
    if (method === 'conversations.archive')
      return receipt.result.archived === true
    if (method === 'conversations.restoreArchive')
      return receipt.result.restored === true
    if (method === 'conversations.deleteArchived' || method === 'conversations.deleteLegacyRemoved')
      return receipt.result.deleted === true
    if (method === 'conversations.setArchivePolicy')
      return conversationArchivePolicySchema.parse(receipt.result.archivePolicy)
    if (method === 'taskMarks.delete')
      return { ok: true }
    if (method === 'conversations.addMember' || method === 'conversations.removeMember')
      return read('conversations.listMembers', { conversationId: input.conversationId })
    if (method.startsWith('conversations.'))
      return read('conversations.get', { conversationId: input.conversationId })
    if (method === 'taskMarks.create' || method === 'taskMarks.update') {
      const marks = await read('taskMarks.list', {}) as Array<{ id: string }>
      return marks.find(mark => mark.id === receipt.target.markId)
    }
    if (method.startsWith('taskMarks.')) {
      const states = await read('taskMarks.states', { conversationIds: [input.conversationId] }) as unknown[]
      return states[0]
    }
    throw gatewayError('METHOD_NOT_AVAILABLE')
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw gatewayError('VALIDATION_FAILED')
  return value as Record<string, unknown>
}
function gatewayError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function outboxOwner(client: ProductRpcClient) {
  const { serviceId, profileId, dataGeneration, deviceId } = client.identity
  return { serviceId, profileId, dataGeneration, deviceId }
}
