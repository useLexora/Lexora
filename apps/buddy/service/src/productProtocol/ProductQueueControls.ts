import type { DatabaseSync } from 'node:sqlite'
import type { ProductQueueControl, ProductQueueControlsInput } from '../../../shared/productProtocol/queries'
import type { ChatQueueService } from '../chat/ChatQueueService'
import { buddyInputDeliverySchema } from '../../../shared/conversation/chatApi'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { productQueueControlSchema } from '../../../shared/productProtocol/queries'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { assertCommittedRead, withTransaction } from '../storage/transaction'
import { ProductPageReader } from './ProductPageReader'

export class ProductQueueControls {
  private readonly database: DatabaseSync
  private readonly instance: string
  private readonly queue: Pick<ChatQueueService, 'inspectControls'>

  constructor(database: DatabaseSync, instance: string, queue: Pick<ChatQueueService, 'inspectControls'>) {
    this.database = database
    this.instance = instance
    this.queue = queue
  }

  async read(input: ProductQueueControlsInput) {
    assertCommittedRead(this.database)
    const assertScope = () => {
      const task = this.database.prepare('SELECT c.archived_at FROM conversations c JOIN conversation_branches b ON b.conversation_id = c.id WHERE c.id = ? AND b.id = ? AND c.deleted_at IS NULL').get(input.conversationId, input.branchId)
      if (!task)
        throw new ProductProtocolError('OBJECT_DELETED')
      return task
    }
    const source = withTransaction(this.database, () => {
      assertScope()
      return new ProductPageReader(this.database, this.instance).read(`chat.queue.list:controls:${input.conversationId}:${input.branchId}`, input, 'chat_queue', 'conversation_id = ? AND branch_id = ? AND state IN (\'waiting\',\'paused\')', [input.conversationId, input.branchId], id => this.database.prepare('SELECT id, CAST(revision AS TEXT) AS revision FROM chat_queue WHERE id = ?').get(id))
    })
    const items: ProductQueueControl[] = []
    for (const sourceItem of source.items) {
      const { id, revision } = sourceItem as { id: string, revision: string }
      const controls = await this.queue.inspectControls({ id, conversationId: input.conversationId, branchId: input.branchId })
      assertCommittedRead(this.database)
      const task = assertScope()
      const row = this.database.prepare('SELECT revision, prepared_json FROM chat_queue WHERE id = ? AND conversation_id = ? AND branch_id = ? AND state IN (\'waiting\',\'paused\')').get(id, input.conversationId, input.branchId)
      if (!row || String(row.revision) !== revision)
        throw new ProductProtocolError('QUEUE_CHANGED')
      const prepared = JSON.parse(String(row.prepared_json)) as { delivery?: unknown }
      const delivery = prepared.delivery === undefined ? null : buddyInputDeliverySchema.parse(prepared.delivery)
      const target = delivery?.target && this.database.prepare('SELECT conversation_id, branch_id, execution_kind FROM runs WHERE id = ?').get(delivery.target.runId)
      const root = delivery?.target && this.database.prepare('SELECT conversation_id, branch_id, execution_kind FROM runs WHERE id = ?').get(delivery.target.rootRunId)
      const actor = delivery && this.database.prepare('SELECT kind FROM buddies WHERE id = ?').get(delivery.actorId)
      const invalidTarget = (delivery && actor?.kind !== 'actor')
        || (target && (target.conversation_id !== input.conversationId || target.branch_id !== input.branchId || !['root', 'actor_child'].includes(String(target.execution_kind))))
        || (root && (root.conversation_id !== input.conversationId || root.branch_id !== input.branchId || root.execution_kind !== 'root'))
      const restricted = task.archived_at !== null || invalidTarget
      items.push(productQueueControlSchema.parse({
        id,
        revision,
        delivery: invalidTarget ? null : delivery,
        allowedActions: restricted ? controls.allowedActions.filter(action => action === 'cancel') : controls.allowedActions,
        steerTarget: !restricted && controls.steerTarget ? { runId: controls.steerTarget.runId, generation: encodeProductRevision(controls.steerTarget.generation) } : null,
        blockedReason: invalidTarget ? 'target_unavailable' : task.archived_at !== null ? 'archived' : controls.blockedReason,
      }))
    }
    return { items, nextCursor: source.nextCursor }
  }
}
