import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { BuddyUserContentV1 } from '../../../shared/conversation/buddyUserContent'
import type { MessageRecord } from '../storage/conversationHistoryRepository'
import type { ProductContentReferences } from './ProductContentReferences'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { buddyUserContentToText, buddyUserMessageContentV1Schema } from '../../../shared/conversation/buddyUserContent'
import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'
import { productErrorCodeSchema, ProductProtocolError } from '../../../shared/productProtocol/errors'
import { productByteLength } from '../../../shared/productProtocol/limits'
import { productQuestionSchema, productRunExecutionSchema } from '../../../shared/productProtocol/queries'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { productApprovalDecisionSchema, productApprovalSchema, productMessageSchema, productQueueItemSchema, productResourceSchema, productRunEventSchema } from '../../../shared/productProtocol/views'
import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import { buddyToolPresentationSchema } from '../../../shared/runs/runEventPresentation'
import { createApprovalRepository } from '../storage/approvalRepository'
import { createArtifactRepository } from '../storage/artifactRepository'
import { createAttachmentRepository } from '../storage/attachmentRepository'
import { findPersonalComposerDraft } from '../storage/composerDraftRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { ExecutionResourceQueries } from '../storage/ExecutionResourceQueries'

const inlineBytes = 131_072
const timestamp = '1970-01-01T00:00:00.000Z'

export class ProductReadViews {
  readonly #database: DatabaseSync
  readonly #actorId: string
  readonly #references: ProductContentReferences
  readonly #hasReview: (approvalId: string, version: string) => boolean

  constructor(database: DatabaseSync, actorId: string, references: ProductContentReferences, hasReview: (approvalId: string, version: string) => boolean = () => false) {
    this.#database = database
    this.#actorId = actorId
    this.#references = references
    this.#hasReview = hasReview
  }

  content(content: BuddyUserContentV1, reference: string, conversationId: string) {
    const portable = this.#references.project(content, { kind: 'conversation', id: conversationId })
    return productByteLength(JSON.stringify(portable)) > inlineBytes
      ? { kind: 'unsupported' as const, contentReference: reference, version: 1, summary: '', readOnly: true as const }
      : { kind: 'editable' as const, content: portable }
  }

  question(id: string) {
    const row = this.#database.prepare('SELECT q.request_json, r.conversation_id, r.branch_id FROM user_questions q JOIN runs r ON r.id = q.run_id JOIN conversations c ON c.id = r.conversation_id WHERE q.id = ? AND c.deleted_at IS NULL').get(id)
    if (!row)
      return null
    const source = JSON.parse(String(row.request_json)) as Record<string, unknown>
    if (source.conversationId !== row.conversation_id || source.branchId !== row.branch_id)
      return null
    return productQuestionSchema.parse(Object.fromEntries(Object.keys(productQuestionSchema.shape).map(key => [key, source[key]])))
  }

  messagePreview(message: Pick<MessageRecord, 'role' | 'content'>): string {
    if (message.role !== 'user' && message.role !== 'assistant')
      return ''
    const user = message.role === 'user' ? buddyUserMessageContentV1Schema.safeParse(message.content) : null
    const text = user?.success ? buddyUserContentToText(user.data.userContent) : publicMessageText(message.content)
    return text === null ? '' : truncateText(text.replace(/\s+/g, ' ').trim(), 240)
  }

  message(message: MessageRecord) {
    const source = message.content && typeof message.content === 'object' && !Array.isArray(message.content) ? message.content as Record<string, unknown> : null
    const user = buddyUserMessageContentV1Schema.safeParse(message.content)
    let body: z.infer<typeof productMessageSchema>['body']
    const resources: z.infer<typeof productResourceSchema>[] = []
    const tool = message.role === 'tool' && typeof source?.toolName === 'string' && typeof source.isError === 'boolean'
      ? { name: source.toolName.slice(0, 256), isError: source.isError }
      : undefined
    if (user.success) {
      body = { kind: 'user', content: this.content(user.data.userContent, `message:${message.id}`, message.conversationId) }
      for (const binding of user.data.resourceSnapshots) {
        if (binding.attachmentId) {
          const resource = this.resource(`attachment:${binding.attachmentId}`)
          if (resource)
            resources.push({ ...resource, bindingId: binding.resourceId })
        }
        else {
          resources.push({ resourceId: `material:${message.id}:${binding.resourceId}`, bindingId: binding.resourceId, kind: 'reference', name: '引用', mimeType: 'application/octet-stream', sizeBytes: '0', revision: digest(binding), availability: 'export_required' })
        }
      }
    }
    else if (publicMessageText(message.content) !== null) {
      const text = publicMessageText(message.content)!
      body = productByteLength(text) <= inlineBytes
        ? { kind: 'text', text, interrupted: source?.state === 'interrupted', truncated: source?.truncated === true }
        : { kind: 'resource', resourceId: `message:${message.id}`, previewText: truncateText(text, 4096), readOnly: true, interrupted: source?.state === 'interrupted', truncated: source?.truncated === true }
      if (Array.isArray(source?.attachmentIds)) {
        for (const id of source.attachmentIds) {
          if (typeof id !== 'string')
            continue
          const resource = this.resource(`attachment:${id}`)
          if (resource)
            resources.push(resource)
        }
      }
    }
    else {
      body = { kind: 'resource', resourceId: `message:${message.id}`, previewText: typeof source?.text === 'string' ? truncateText(source.text, 4096) : '', readOnly: true }
    }
    if (tool && body.kind === 'resource') {
      const presentation = this.#toolPresentation(message, source)
      if (presentation) {
        const fields = presentation as Record<string, unknown>
        const summary = ['description', 'command', 'path', 'query', 'glob', 'target', 'operation', 'tool']
          .map(key => fields[key])
          .find(value => typeof value === 'string' && value.trim())
        if (typeof summary === 'string')
          body.previewText = truncateText(redactSensitiveText(summary).replace(/\s+/g, ' ').trim(), 240)
      }
    }
    let author: z.infer<typeof productMessageSchema>['author']
    if (message.role === 'assistant' && message.runId) {
      const run = this.#database.prepare(`SELECT r.actor_snapshot_json FROM runs r JOIN conversations c ON c.id = r.conversation_id
        WHERE r.id = ? AND r.conversation_id = ? AND r.branch_id = ? AND r.execution_kind IN ('root', 'actor_child') AND c.deleted_at IS NULL`)
        .get(message.runId, message.conversationId, message.branchId)
      if (typeof run?.actor_snapshot_json === 'string') {
        try {
          const snapshot = JSON.parse(run.actor_snapshot_json) as Record<string, unknown> | null
          const identity = productMessageSchema.shape.author.unwrap().safeParse({ id: snapshot?.id, name: snapshot?.name })
          if (identity.success)
            author = identity.data
        }
        catch {}
      }
    }
    return productMessageSchema.parse({ id: message.id, conversationId: message.conversationId, branchId: message.branchId, runId: message.runId, role: message.role, createdAt: message.createdAt, body, resources, ...(tool ? { tool } : {}), ...(author ? { author } : {}) })
  }

  approval(id: string, localEffects = false) {
    const approval = createApprovalRepository(this.#database).findById(id)
    if (!approval || !this.#visibleRun(approval.runId))
      return null
    const scope = this.#database.prepare('SELECT conversation_id, branch_id FROM runs WHERE id = ?').get(approval.runId)!
    const review = approval.review
    let projected: z.infer<typeof productApprovalSchema>['review'] = null
    if (review) {
      const document = reviewDocument(review.body)
      const inline = productByteLength(document) <= inlineBytes
      const localManagementRequired = review.persistentEffect && !localEffects
      const complete = review.complete && (inline || this.#hasReview(id, review.reviewVersion)) && Date.parse(review.expiresAt) > Date.now()
      projected = {
        contentVersion: review.contentVersion,
        operationDigest: review.operationDigest,
        reviewVersion: review.reviewVersion,
        expiresAt: review.expiresAt,
        persistentEffect: review.persistentEffect,
        complete,
        allowedDecisions: complete && !localManagementRequired ? review.allowedDecisions : ['denied'],
        document: inline ? { format: 'json', text: document } : null,
        resourceId: inline ? null : `review:${id}:${review.reviewVersion}`,
        localManagementRequired,
      }
    }
    return productApprovalSchema.parse({ id, runId: approval.runId, conversationId: scope.conversation_id, branchId: scope.branch_id, kind: approval.kind, summary: redactSensitiveText(approval.summary).slice(0, 4096), status: approval.status, createdAt: approval.createdAt, resolvedAt: approval.resolvedAt, resolution: approval.resolution ?? null, review: projected })
  }

  approvalDecision(id: string) {
    const approval = createApprovalRepository(this.#database).findById(id)
    if (!approval || approval.status === 'pending' || !this.#visibleRun(approval.runId))
      return null
    const localActor = this.#database.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get()!.local_actor_id
    const actor = approval.decisionActorId
      ? { id: approval.decisionActorId, kind: approval.decisionActorId === localActor ? 'desktop' : 'device', current: approval.decisionActorId === this.#actorId }
      : null
    return productApprovalDecisionSchema.parse({ approvalId: id, runId: approval.runId, reviewVersion: approval.review?.reviewVersion ?? null, status: approval.status, resolution: approval.resolution ?? null, resolvedAt: approval.resolvedAt, actor, cancellationReason: approval.cancellationReason ?? null })
  }

  queue(id: string) {
    const row = this.#database.prepare('SELECT * FROM chat_queue WHERE id = ?').get(id)
    if (!row || !this.#visibleTask(String(row.conversation_id)))
      return null
    const input = JSON.parse(String(row.prepared_json)) as Record<string, unknown>
    const user = buddyUserMessageContentV1Schema.safeParse(input.userMessageContent)
    if (!user.success)
      throw new ProductProtocolError('CONTENT_UNSUPPORTED')
    const active = this.#database.prepare(`SELECT id, generation FROM runs WHERE conversation_id = ? AND branch_id = ? AND execution_kind = 'root' AND status IN ('running','queued') ORDER BY started_at DESC LIMIT 1`).get(String(row.conversation_id), String(row.branch_id))
    return productQueueItemSchema.parse({ id, conversationId: row.conversation_id, branchId: row.branch_id, revision: encodeProductRevision(Number(row.revision)), state: row.state, createdAt: row.created_at, sourceRunId: typeof input.sourceRunId === 'string' ? input.sourceRunId : null, content: this.content(user.data.userContent, `queue:${id}`, String(row.conversation_id)), steerTarget: active ? { runId: String(active.id), generation: encodeProductRevision(Number(active.generation)) } : null })
  }

  runExecution(runId: string) {
    if (!this.#publicRun(runId))
      return null
    const row = this.#database.prepare('SELECT r.generation, e.phase, e.cancel_requested_at, e.cleanup_state FROM runs r JOIN execution_state e ON e.run_id = r.id WHERE r.id = ?').get(runId)
    if (!row)
      return null
    const resources = new ExecutionResourceQueries(this.#database).subtree(runId)
    return productRunExecutionSchema.parse({ runId, generation: encodeProductRevision(Number(row.generation)), phase: row.phase, cancelRequested: row.cancel_requested_at !== null, resources })
  }

  transcriptEvent(runId: string, sequence: string) {
    if (!this.#publicRun(runId))
      return null
    const run = this.#database.prepare('SELECT execution_kind FROM runs WHERE id = ?').get(runId)
    if (run?.execution_kind !== 'root')
      return null
    const row = this.#database.prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence = ?').get(runId, BigInt(sequence))
    if (!row)
      return null
    const event = toPublicRunEvent({ runId, sequence: Number(sequence), createdAt: String(row.created_at), type: String(row.event_type), payload: JSON.parse(String(row.payload_json)) })
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string')
        return redactSensitiveText(value)
      if (Array.isArray(value))
        return value.map(redact)
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
      return value
    }
    return { ...event, payload: redact(event.payload) }
  }

  event(runId: string, sequence: string) {
    if (!this.#publicRun(runId))
      return null
    const row = this.#database.prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence = ?').get(runId, BigInt(sequence))
    if (!row)
      return null
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>
    let detail: z.infer<typeof productRunEventSchema>['detail'] = { kind: 'status' }
    const run = this.#database.prepare('SELECT execution_kind FROM runs WHERE id = ?').get(runId)
    const publicText = run?.execution_kind === 'root' || (run?.execution_kind === 'actor_child' && typeof payload.messageId === 'string' && Boolean(createConversationRepository(this.#database).findMessageById(payload.messageId)))
    if (publicText && row.event_type === 'message.delta' && typeof payload.messageId === 'string' && typeof payload.delta === 'string' && productByteLength(payload.delta) <= 65_536) {
      detail = { kind: 'text_delta', messageId: payload.messageId, delta: payload.delta, phase: payload.phase === 'commentary' || payload.phase === 'final_answer' ? payload.phase : null }
    }
    else {
      const fields: Record<string, string> = {}
      for (const key of publicText ? ['messageId', 'toolCallId', 'toolName'] : []) {
        if (typeof payload[key] === 'string')
          fields[key] = payload[key].slice(0, 256)
      }
      if (String(row.event_type).startsWith('approval.') && typeof payload.id === 'string')
        fields.approvalId = payload.id
      const code = productErrorCodeSchema.safeParse(payload.errorCode)
      if (code.success)
        fields.errorCode = code.data
      detail = { kind: 'status', ...fields }
    }
    return productRunEventSchema.parse({ runId, sequence, createdAt: row.created_at, type: row.event_type, detail })
  }

  resource(resourceId: string): z.infer<typeof productResourceSchema> | null {
    const [kind, id] = resourceId.split(':')
    if (!id)
      return null
    if (kind === 'attachment') {
      const repository = createAttachmentRepository(this.#database)
      const attachment = repository.findVisibleById(id)
      if (!attachment)
        return null
      if (attachment.messageId && !createConversationRepository(this.#database).findMessageById(attachment.messageId))
        return null
      if (attachment.draftId && !findPersonalComposerDraft(this.#database, attachment.draftId) && !this.#database.prepare('SELECT 1 FROM remote_uploads WHERE actor_id = ? AND input_id IS NOT NULL AND attachment_id = ? AND state = \'ready\' AND expires_ms > ?').get(this.#actorId, id, Date.now()) && !this.#database.prepare('SELECT 1 FROM chat_queue q JOIN conversations c ON c.id = q.conversation_id WHERE q.id = ? AND c.deleted_at IS NULL').get(attachment.draftId))
        return null
      const file = repository.persistence!.get(attachment.storedPath)
      return productResourceSchema.parse({ resourceId, kind, name: displayName(attachment.name), mimeType: attachment.mimeType, sizeBytes: encodeProductRevision(attachment.sizeBytes), revision: file?.sha256 ?? 'unavailable', availability: file?.state === 'ready' ? 'ready' : 'unavailable' })
    }
    if (kind === 'artifact') {
      const artifact = createArtifactRepository(this.#database).findVisibleById(id)
      if (!artifact)
        return null
      return productResourceSchema.parse({ resourceId, kind, name: displayName(artifact.name), mimeType: artifact.mimeType, sizeBytes: encodeProductRevision(artifact.sizeBytes), revision: digest([artifact.id, artifact.updatedAt, artifact.sizeBytes]), availability: 'export_required' })
    }
    if (kind === 'message') {
      const message = createConversationRepository(this.#database).findMessageById(id)
      if (!message || !this.#visibleTask(message.conversationId))
        return null
      const bytes = this.document(resourceId)
      return productResourceSchema.parse({ resourceId, kind, name: '消息内容', mimeType: bytes?.mimeType ?? 'application/json', sizeBytes: encodeProductRevision(bytes?.bytes.byteLength ?? 0), revision: digest(message.content), availability: bytes ? 'ready' : 'unavailable' })
    }
    if (kind === 'review') {
      const approval = createApprovalRepository(this.#database).findById(id)
      if (!approval?.review || !this.#visibleRun(approval.runId) || resourceId !== `review:${id}:${approval.review.reviewVersion}`)
        return null
      return productResourceSchema.parse({ resourceId, kind, name: '完整审批内容', mimeType: 'application/json', sizeBytes: encodeProductRevision(productByteLength(reviewDocument(approval.review.body))), revision: approval.review.reviewVersion, availability: approval.review.complete ? 'ready' : 'unavailable' })
    }
    return null
  }

  document(resourceId: string): { bytes: Buffer, mimeType: string, revision: string } | null {
    const [kind, id] = resourceId.split(':')
    if (!id)
      return null
    if (kind === 'review') {
      const approval = createApprovalRepository(this.#database).findById(id)
      if (!approval?.review?.complete || !this.#visibleRun(approval.runId) || resourceId !== `review:${id}:${approval.review.reviewVersion}`)
        return null
      return { bytes: Buffer.from(reviewDocument(approval.review.body)), mimeType: 'application/json', revision: approval.review.reviewVersion }
    }
    if (kind !== 'message')
      return null
    const message = createConversationRepository(this.#database).findMessageById(id)
    if (!message || !this.#visibleTask(message.conversationId))
      return null
    const user = buddyUserMessageContentV1Schema.safeParse(message.content)
    if (user.success)
      return { bytes: Buffer.from(JSON.stringify(this.#references.project(user.data.userContent, { kind: 'conversation', id: message.conversationId }))), mimeType: 'application/json', revision: digest(message.content) }
    const source = message.content && typeof message.content === 'object' && !Array.isArray(message.content) ? message.content as Record<string, unknown> : null
    if (typeof message.content === 'string' || (source && typeof source.text === 'string' && Object.keys(source).every(key => ['text', 'attachmentIds', 'modelId', 'providerId', 'state', 'truncated'].includes(key))))
      return { bytes: Buffer.from(typeof message.content === 'string' ? message.content : String(source!.text)), mimeType: 'text/plain; charset=utf-8', revision: digest(message.content) }
    if (message.role === 'tool' && message.runId && typeof source?.toolCallId === 'string' && typeof source.toolName === 'string') {
      const presentation = this.#toolPresentation(message, source)
      const lines = [`工具：${source.toolName}`, `结果：${source.isError === true ? '执行失败' : '已完成'}`]
      if (presentation) {
        const labels: Record<string, string> = { description: '说明', command: '命令', cwd: '工作目录', path: '文件', query: '查询', glob: '文件匹配', target: '目标', operation: '操作', tool: '调用', connector: '连接器', exitCode: '退出码', signal: '信号', diff: '文件变更', output: '输出', status: '状态', errorCode: '错误' }
        const fields = presentation as Record<string, unknown>
        for (const [key, label] of Object.entries(labels)) {
          const value = fields[key]
          if ((typeof value === 'string' && value) || typeof value === 'number')
            lines.push(`${label}：\n${redactSensitiveText(String(value))}`)
        }
        if (fields.truncated === true)
          lines.push('此调用保存的输出已截断；以上是当前可读取的全部内容。')
      }
      else {
        lines.push('这条历史调用未保存可读取的参数和输出。')
      }
      const text = lines.join('\n\n')
      return { bytes: Buffer.from(text), mimeType: 'text/plain; charset=utf-8', revision: digest(message.content) }
    }
    return null
  }

  #toolPresentation(message: MessageRecord, source: Record<string, unknown> | null) {
    if (!message.runId || typeof source?.toolCallId !== 'string' || !this.#visibleRun(message.runId))
      return null
    const row = this.#database.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND event_type = 'tool.completed'
      AND json_extract(payload_json, '$.toolCallId') = ? ORDER BY sequence DESC LIMIT 1`).get(message.runId, source.toolCallId)
    const payload = row ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : null
    const presentation = buddyToolPresentationSchema.safeParse(payload?.presentation)
    return presentation.success ? presentation.data : null
  }

  #publicRun(id: string): boolean {
    return this.#visibleRun(id) && !!this.#database.prepare('SELECT 1 FROM runs WHERE id = ? AND execution_kind IN (\'root\', \'actor_child\', \'maintenance\')').get(id)
  }

  #visibleTask(id: string): boolean {
    return Boolean(this.#database.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id))
  }

  #visibleRun(id: string): boolean {
    return Boolean(this.#database.prepare('SELECT 1 FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ? AND c.deleted_at IS NULL').get(id))
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function publicMessageText(value: unknown): string | null {
  if (typeof value === 'string')
    return value
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const source = value as Record<string, unknown>
  return typeof source.text === 'string' && Object.keys(source).every(key => ['text', 'attachmentIds', 'modelId', 'providerId', 'state', 'truncated'].includes(key)) ? source.text : null
}
function truncateText(value: string, limit: number): string {
  const end = value.charCodeAt(limit - 1)
  return value.slice(0, end >= 0xD800 && end <= 0xDBFF ? limit - 1 : limit)
}
function displayName(value: string): string {
  return value.replaceAll('\\', '/').split('/').at(-1)!.slice(0, 512)
}
function reviewDocument(value: unknown): string {
  const internal = new Set(['lifetimeId', 'pageId', 'sessionId', 'observationId', 'actionDigest'])
  const sensitive = /password|passwd|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key/i
  return JSON.stringify(value ?? { createdAt: timestamp }, (key, item) => internal.has(key) ? undefined : sensitive.test(key) ? '[redacted]' : typeof item === 'string' ? redactSensitiveText(item) : item, 2)
}
