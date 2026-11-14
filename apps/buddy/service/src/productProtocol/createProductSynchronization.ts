import type { DatabaseSync } from 'node:sqlite'
import type { ChatQueueService } from '../chat/ChatQueueService'
import type { ComposerDraftService } from '../chat/ComposerDraftService'
import type { ConversationArchiveService } from '../conversations/ConversationArchiveService'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type { ConversationMetadataService } from '../conversations/ConversationMetadataService'
import type { TaskMarkService } from '../conversations/TaskMarkService'
import type { RunEventLogPort } from '../events/RunEventPorts'
import type { UserQuestionService } from '../questions/UserQuestionService'
import type { ProductQueries } from './ProductQueries'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS } from '../../../shared/productProtocol/limits'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { formatProductTopic, parseProductTopic, PRODUCT_TOPIC_SCHEMAS } from '../../../shared/productProtocol/topics'
import { createConversationRepository } from '../storage/conversationRepository'
import { ProductSyncPublisher } from './ProductSyncPublisher'

export function createProductSynchronization(options: {
  database: DatabaseSync
  queries: ProductQueries
  drafts: Pick<ComposerDraftService, 'onDidCommit'>
  metadata: Pick<ConversationMetadataService, 'onDidCommit'>
  lifecycle: Pick<ConversationLifecycleService, 'onDidCommit'>
  archive?: Pick<ConversationArchiveService, 'onDidChange'>
  marks?: Pick<TaskMarkService, 'onDidCommit'>
  questions?: Pick<UserQuestionService, 'onDidCommit'>
  events: Pick<RunEventLogPort, 'onDidCommit'>
  queue?: Pick<ChatQueueService, 'onDidChange'>
}) {
  const publisher = new ProductSyncPublisher()
  const { queries, database } = options
  const dynamic = new Map<string, () => void>()
  function register(name: string) {
    const topic = parseProductTopic(name)
    const schemas = PRODUCT_TOPIC_SCHEMAS[topic.kind]
    return publisher.register(name, { ...schemas, openSnapshot: () => {
      const reader = queries.openSnapshot(name)
      return { close: reader.close, read: (cursor) => {
        const page = reader.read(cursor)
        return { ...page, items: page.items.map(item => schemas.item.parse(item)) }
      } }
    }, readSnapshot: () => {
      const page = queries.snapshot(name)
      return { ...page, items: page.items.map(item => schemas.item.parse(item)) }
    } })
  }
  for (const name of ['taskIndex', 'draftIndex', 'approvalInbox', 'serviceState']) register(name)
  function authorizeTopic(name: string) {
    let topic
    try {
      topic = parseProductTopic(name)
    }
    catch { throw new ProductProtocolError('NOT_AUTHORIZED') }
    queries.assertTopic(topic)
    if (publisher.hasTopic(name))
      return
    if (dynamic.size >= PRODUCT_LIMITS.dynamicTopics) {
      const idle = [...dynamic].find(([key]) => publisher.subscriptionCount(key) === 0)
      if (!idle)
        throw new ProductProtocolError('SYNC_INVALID')
      idle[1]()
      dynamic.delete(idle[0])
    }
    dynamic.set(name, register(name))
  }
  const publish = (name: string, changes: () => unknown[]) => {
    if (!publisher.hasTopic(name))
      return
    publisher.publishCommitted(name, () => {
      const schema = PRODUCT_TOPIC_SCHEMAS[parseProductTopic(name).kind].change
      return changes().map(change => schema.parse(change))
    })
  }
  const conversationTopics = (conversationId: string) => [...dynamic.keys()].filter((name) => {
    const topic = parseProductTopic(name)
    return topic.kind === 'conversation' && topic.conversationId === conversationId
  })
  const publishTask = (id: string) => {
    publish('taskIndex', () => {
      const value = queries.task(id, true)
      return [value ? { kind: 'upsert', value } : { kind: 'remove', id }]
    })
    for (const name of conversationTopics(id)) {
      publish(name, () => {
        const value = queries.task(id)
        return [value ? { kind: 'upsert', item: { entity: 'task', value } } : { kind: 'remove', entity: 'task', id }]
      })
    }
  }
  const publishVisibility = (conversationId: string) => {
    publishTask(conversationId)
    for (const name of conversationTopics(conversationId)) publisher.invalidate(name)
    for (const name of dynamic.keys()) {
      const topic = parseProductTopic(name)
      if (topic.kind === 'questions' && topic.conversationId === conversationId)
        publisher.invalidate(name)
    }
    publisher.invalidate('approvalInbox')
  }
  const subscriptions = [
    options.drafts.onDidCommit(({ draftId }) => {
      const changes = () => {
        const value = queries.draft(draftId)
        return [value ? { kind: 'upsert', value } : { kind: 'remove', id: draftId }]
      }
      publish('draftIndex', changes)
      publish(formatProductTopic({ kind: 'draft', draftId }), changes)
    }),
    options.metadata.onDidCommit(({ conversation }) => publishTask(conversation.id)),
    options.lifecycle.onDidCommit(({ conversationId }) => publishVisibility(conversationId)),
    options.events.onDidCommit(({ runId, type, sequence, payload, createdAt }) => {
      const row = database.prepare('SELECT conversation_id, branch_id FROM runs WHERE id = ?').get(runId)
      if (!row)
        return
      const conversationId = String(row.conversation_id)
      const branchId = String(row.branch_id)
      if (['run.queued', 'run.started', 'run.completed', 'run.failed', 'run.cancelled', 'message.created', 'message.completed', 'message.block.completed', 'approval.requested', 'approval.resolved'].includes(type))
        publishTask(conversationId)
      const name = formatProductTopic({ kind: 'conversation', conversationId, branchId })
      publish(name, () => {
        const event = queries.views.event(runId, encodeProductRevision(sequence))
        const changes: unknown[] = event ? [{ kind: 'event', event }] : []
        if (type === 'message.started' && payload && typeof payload === 'object' && 'role' in payload && payload.role === 'assistant' && 'messageId' in payload && typeof payload.messageId === 'string') {
          const value = queries.streaming.start(runId, payload.messageId, createdAt)
          if (value)
            changes.push({ kind: 'upsert', item: { entity: 'message', value } })
        }
        if (type.startsWith('run.')) {
          const value = queries.read('runs.get', { runId })
          if (value)
            changes.push({ kind: 'upsert', item: { entity: 'run', value } })
        }
        if (['message.created', 'message.completed', 'message.block.completed', 'run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
          const rows = database.prepare('SELECT id FROM messages WHERE run_id = ? LIMIT ?').all(runId, PRODUCT_LIMITS.subscriptionItems + 1)
          if (rows.length > PRODUCT_LIMITS.subscriptionItems)
            throw new ProductProtocolError('RESYNC_REQUIRED')
          const conversations = createConversationRepository(database)
          for (const row of rows) {
            const message = conversations.findMessageById(String(row.id))
            if (message)
              changes.push({ kind: 'upsert', item: { entity: 'message', value: queries.views.message(message) } })
          }
        }
        if (type.startsWith('approval.')) {
          for (const row of database.prepare('SELECT id FROM approvals WHERE run_id = ? LIMIT ?').all(runId, PRODUCT_LIMITS.subscriptionItems + 1)) {
            const value = queries.views.approval(String(row.id))
            if (value)
              changes.push({ kind: 'upsert', item: { entity: 'approval', value } })
          }
        }
        return changes
      })
      if (type.startsWith('approval.')) {
        publish('approvalInbox', () => database.prepare('SELECT id FROM approvals WHERE run_id = ? LIMIT ?').all(runId, PRODUCT_LIMITS.subscriptionItems + 1).map((row) => {
          const id = String(row.id)
          const value = queries.views.approval(id)
          return value?.status === 'pending' ? { kind: 'upsert', value } : { kind: 'remove', id }
        }))
      }
    }),
  ]
  if (options.archive)
    subscriptions.push(options.archive.onDidChange(publishVisibility))
  if (options.questions) {
    subscriptions.push(options.questions.onDidCommit(({ conversationId, branchId, requestId }) => {
      publishTask(conversationId)
      publish(formatProductTopic({ kind: 'questions', conversationId, branchId }), () => {
        const value = queries.views.question(requestId)
        return [value ? { kind: 'upsert', value } : { kind: 'remove', id: requestId }]
      })
    }))
  }
  if (options.marks) {
    subscriptions.push(options.marks.onDidCommit((event) => {
      if (event.kind === 'attention')
        publishTask(event.conversationId)
      else if (event.kind === 'deleted')
        event.conversationIds.forEach(publishTask)
    }))
  }
  if (options.queue) {
    subscriptions.push(options.queue.onDidChange(({ scope, committed }) => {
      const name = formatProductTopic({ kind: 'conversation', conversationId: scope.conversationId, branchId: scope.branchId })
      if (!committed?.queueId) {
        publisher.invalidate(name)
        return
      }
      publish(name, () => {
        const value = queries.views.queue(committed.queueId)
        return value && ['waiting', 'paused'].includes(value.state)
          ? [{ kind: 'upsert', item: { entity: 'queue', value } }]
          : [{ kind: 'remove', entity: 'queue', id: committed.queueId }]
      })
    }))
  }
  return { publisher, authorizeTopic, stopping: () => publish('serviceState', () => [{ phase: 'stopping' }]), dispose: () => subscriptions.forEach(subscription => subscription.dispose()) }
}
