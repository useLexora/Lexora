import type { DatabaseSync } from 'node:sqlite'
import type { BuddyResourceQuote, BuddyUserContentV1 } from '../../../shared/conversation/buddyUserContent'
import { createHash } from 'node:crypto'
import { buddyResourceQuoteSchema } from '../../../shared/conversation/buddyUserContent'
import { projectProductContent } from '../../../shared/productProtocol/content'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { canonicalCommandJson } from '../commands/commandIntent'
import { requireSqliteAuthority } from '../storage/sqliteAuthority'
import { assertCommittedRead, withTransaction } from '../storage/transaction'

export interface ProductContentReferenceSource {
  kind: 'conversation' | 'draft'
  id: string
}

export class ProductContentReferences {
  readonly #database: DatabaseSync
  readonly #actorId: string

  constructor(database: DatabaseSync, actorId: string) {
    this.#database = database
    this.#actorId = actorId
  }

  project(content: BuddyUserContentV1, source?: ProductContentReferenceSource) {
    return withTransaction(this.#database, () => {
      const owner = source ? this.#owner(source) : null
      return projectProductContent(content, (quote) => {
        const dataGeneration = requireSqliteAuthority(this.#database).dataGeneration
        const bytes = canonicalCommandJson(buddyResourceQuoteSchema.parse(quote))
        const resourceId = createHash('sha256').update(canonicalCommandJson([this.#actorId, dataGeneration, quote])).digest('hex')
        const existing = this.#database.prepare('SELECT quote_json, owner_actor_id, data_generation FROM product_content_references WHERE id = ?').get(resourceId)
        if (existing && (existing.quote_json !== bytes || existing.owner_actor_id !== this.#actorId || existing.data_generation !== dataGeneration))
          throw new ProductProtocolError('SOURCE_CHANGED')
        if (!existing) {
          this.#database.prepare(`INSERT INTO product_content_references(id, owner_actor_id, data_generation, quote_json, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(resourceId, this.#actorId, dataGeneration, bytes, new Date().toISOString())
        }
        if (owner) {
          this.#database.prepare(`INSERT OR IGNORE INTO product_content_reference_owners (reference_id, owner_kind, owner_id)
            VALUES (?, ?, ?)`).run(resourceId, owner.kind, owner.id)
        }
        return { resourceId, title: 'title' in quote.source ? quote.source.title : '引用' }
      })
    })
  }

  #owner(source: ProductContentReferenceSource): ProductContentReferenceSource {
    if (source.kind === 'draft') {
      const draft = this.#database.prepare('SELECT conversation_id FROM composer_drafts WHERE id = ?').get(source.id)
      if (!draft)
        throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
      if (!draft.conversation_id)
        return source
      source = { kind: 'conversation', id: String(draft.conversation_id) }
    }
    if (!this.#database.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(source.id))
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
    return source
  }

  resolve(resourceId: string): BuddyResourceQuote {
    assertCommittedRead(this.#database)
    const dataGeneration = requireSqliteAuthority(this.#database).dataGeneration
    const record = this.#database.prepare('SELECT quote_json FROM product_content_references WHERE id = ? AND owner_actor_id = ? AND data_generation = ?').get(resourceId, this.#actorId, dataGeneration)
    if (!record)
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
    return buddyResourceQuoteSchema.parse(JSON.parse(String(record.quote_json)))
  }
}
