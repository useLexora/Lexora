import type { DatabaseSync } from 'node:sqlite'
import type { BuddyComposerDraft } from '../../../shared/conversation/composerDraft'
import type { ProductContentReferences } from './ProductContentReferences'
import type { ProductReadViews } from './ProductReadViews'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { productDraftSchema } from '../../../shared/productProtocol/queries'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { createComposerDraftRepository, findPersonalComposerDraft } from '../storage/composerDraftRepository'
import { createDraftOwnershipRepository } from '../storage/draftOwnershipRepository'

export class ProductDraftReadModel {
  readonly #database: DatabaseSync
  readonly #actorId: string
  readonly #references: ProductContentReferences
  readonly #resource: ProductReadViews['resource']

  constructor(database: DatabaseSync, actorId: string, references: ProductContentReferences, resource: ProductReadViews['resource']) {
    this.#database = database
    this.#actorId = actorId
    this.#references = references
    this.#resource = resource
  }

  get(id: string) {
    const draft = findPersonalComposerDraft(this.#database, id)
    return draft ? this.#projectDraft(draft) : null
  }

  find(scope: BuddyComposerDraft['scope']) {
    const slot = createDraftOwnershipRepository(this.#database, this.#actorId).findSlot(scope)
    const draft = slot?.draftId ? createComposerDraftRepository(this.#database, this.#actorId).findById(slot.draftId) : null
    return { draft: draft ? this.#projectDraft(draft) : null, slotRevision: encodeProductRevision(slot?.slotRevision ?? 0) }
  }

  #projectDraft(draft: BuddyComposerDraft) {
    const content = this.#references.project(draft.content, { kind: 'draft', id: draft.draftId })
    const projected = productByteLength(JSON.stringify(content)) > PRODUCT_LIMITS.pageBytes / 2
      ? { kind: 'unsupported' as const, contentReference: `draft:${draft.draftId}:${draft.revision}`, version: 1, summary: '', readOnly: true as const }
      : { kind: 'editable' as const, content }
    const resources = this.#database.prepare('SELECT id, attachment_id FROM composer_resources WHERE draft_id = ? ORDER BY created_at, id LIMIT 16').all(draft.draftId).flatMap((row) => {
      const resource = row.attachment_id ? this.#resource(`attachment:${String(row.attachment_id)}`) : null
      return resource ? [{ ...resource, bindingId: String(row.id) }] : []
    })
    return productDraftSchema.parse({ ...draft, resources, ownerDeviceId: String(this.#database.prepare('SELECT owner_actor_id FROM composer_drafts WHERE id = ?').get(draft.draftId)!.owner_actor_id), writable: Boolean(this.#database.prepare('SELECT 1 FROM composer_drafts WHERE id = ? AND owner_actor_id = ?').get(draft.draftId, this.#actorId)), revision: encodeProductRevision(draft.revision), content: projected })
  }
}
