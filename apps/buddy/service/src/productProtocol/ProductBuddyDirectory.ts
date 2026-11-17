import type { DatabaseSync } from 'node:sqlite'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { productBuddyProfileSchema } from '../../../shared/productProtocol/queries'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { createConversationMemberRepository } from '../storage/conversationMemberRepository'
import { ProductPageReader } from './ProductPageReader'

export class ProductBuddyDirectory {
  readonly #database: DatabaseSync
  readonly #pages: ProductPageReader

  constructor(database: DatabaseSync, instance: string) {
    this.#database = database
    this.#pages = new ProductPageReader(database, instance)
  }

  profile(id: string) {
    const row = this.#database.prepare('SELECT id, name, description, enabled, deleted_at, revision FROM buddies WHERE id = ? AND kind = \'actor\'').get(id)
    return row ? productBuddyProfileSchema.parse({ id: row.id, name: row.name, description: row.description, enabled: row.enabled === 1, deleted: row.deleted_at !== null, revision: encodeProductRevision(Number(row.revision)) }) : null
  }

  list(input: Record<string, unknown>) {
    const catalog = this.#database.prepare('SELECT revision, default_buddy_id FROM buddy_catalog WHERE id = 1').get()!
    const catalogRevision = encodeProductRevision(Number(catalog.revision))
    return { ...this.#pages.read('buddies.list', input, 'buddies', 'kind = \'actor\' AND deleted_at IS NULL', [], id => this.profile(id), catalogRevision), catalogRevision, defaultBuddyId: String(catalog.default_buddy_id) }
  }

  members(input: Record<string, unknown>) {
    const conversationId = String(input.conversationId)
    const task = this.#database.prepare('SELECT buddy_id, metadata_revision FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId)
    if (!task)
      throw new ProductProtocolError('OBJECT_DELETED')
    const revision = encodeProductRevision(Number(task.metadata_revision))
    const catalog = this.#database.prepare('SELECT revision FROM buddy_catalog WHERE id = 1').get()!
    const members = createConversationMemberRepository(this.#database)
    const page = this.#pages.read(`conversations.listMembers:${conversationId}:${revision}`, input, '(SELECT rowid, actor_id AS id, conversation_id, removed_at FROM conversation_members)', 'conversation_id = ? AND removed_at IS NULL', [conversationId], (id) => {
      const member = members.find(conversationId, id)
      const profile = this.profile(id)
      return member && profile ? { actorId: id, profile, modelSelection: member.modelSelection, modelSelectionSource: member.modelSelectionSource, joinedAt: member.joinedAt } : null
    }, encodeProductRevision(Number(catalog.revision)))
    return { ...page, conversationId, buddyId: String(task.buddy_id), revision }
  }
}
