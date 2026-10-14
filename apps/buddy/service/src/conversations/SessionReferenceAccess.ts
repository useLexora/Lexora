import type { SessionReferenceAccess, SessionReferenceAccessList } from '../../../shared/conversation/sessionReferenceAccess'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { SessionReferenceRepository, SessionReferenceScope } from '../storage/sessionReferenceRepository'
import { z } from 'zod'
import { SESSION_REFERENCE_CHAIN_DEPTH, SESSION_REFERENCE_COUNT_LIMIT, SESSION_REFERENCE_MESSAGE_LIMIT, sessionReferenceAccessSchema } from '../../../shared/conversation/sessionReferenceAccess'

interface ReferenceEdge {
  from: string
  messageId: string
}

interface ReferenceNode {
  reference: SessionReferenceAccess
  scope: SessionReferenceScope | null
  edges: ReferenceEdge[]
}

const graphSchema = z.object({
  nodes: z.array(z.object({
    reference: sessionReferenceAccessSchema,
    scope: z.object({ conversationId: z.string(), branchId: z.string(), throughSequence: z.number().int().nonnegative() }).strict().nullable(),
    edges: z.array(z.object({ from: z.string(), messageId: z.string() }).strict()).max(SESSION_REFERENCE_MESSAGE_LIMIT * 16),
  }).strict()).max(SESSION_REFERENCE_COUNT_LIMIT),
  truncated: z.boolean(),
}).strict()

export class SessionReferenceAccessResolver {
  readonly #conversations: Pick<ConversationRepository, 'findById'>
  readonly #repository: SessionReferenceRepository
  #key = ''
  #scope: SessionReferenceScope | null = null
  #nodes = new Map<string, ReferenceNode>()
  #truncated = false

  constructor(conversations: Pick<ConversationRepository, 'findById'>, repository: SessionReferenceRepository) {
    this.#conversations = conversations
    this.#repository = repository
  }

  resolve(scope: SessionReferenceScope | null, runId = ''): SessionReferenceAccessList {
    const key = JSON.stringify([scope, runId])
    if (key !== this.#key) {
      this.#key = ''
      this.#scope = scope
      this.#nodes = new Map()
      const persisted = scope && runId ? this.#repository.readGraph(runId, scope.throughSequence) : null
      if (persisted !== null) {
        const graph = graphSchema.parse(persisted)
        this.#nodes = new Map(graph.nodes.map(node => [node.reference.id, node]))
        this.#truncated = graph.truncated
      }
      else {
        this.#build()
        if (scope && runId)
          this.#repository.saveGraph(runId, scope.throughSequence, { nodes: [...this.#nodes.values()], truncated: this.#truncated })
      }
      this.#key = key
    }
    return this.#validate()
  }

  #build(): void {
    this.#nodes = new Map()
    this.#truncated = false
    const root = this.#scope
    if (!root)
      return
    const queue = [{ id: root.conversationId, scope: root, depth: -1 }]
    let remaining = SESSION_REFERENCE_MESSAGE_LIMIT
    for (const parent of queue) {
      const page = this.#repository.listReferences(parent.scope, remaining)
      remaining -= page.items.length
      this.#truncated ||= page.truncated
      for (const message of page.items) {
        for (const reference of message.references) {
          if (reference.id === root.conversationId || reference.id === parent.id)
            continue
          const known = this.#nodes.get(reference.id)
          if (known) {
            known.edges.push({ from: parent.id, messageId: message.messageId })
            continue
          }
          if (parent.depth === SESSION_REFERENCE_CHAIN_DEPTH || this.#nodes.size === SESSION_REFERENCE_COUNT_LIMIT) {
            this.#truncated = true
            continue
          }
          const target = this.#conversations.findById(reference.id)
          const scope = target && !target.deletedAt && target.activeBranchId
            ? { conversationId: target.id, branchId: target.activeBranchId, throughSequence: this.#repository.headSequence(target.id) }
            : null
          const depth = parent.depth + 1
          this.#nodes.set(reference.id, {
            reference: { ...reference, title: target?.title ?? reference.title, branchId: scope?.branchId ?? null, depth, via: [], status: scope ? 'available' : 'unavailable' },
            scope,
            edges: [{ from: parent.id, messageId: message.messageId }],
          })
          if (scope)
            queue.push({ id: reference.id, scope, depth })
        }
      }
    }
  }

  #validate(): SessionReferenceAccessList {
    const root = this.#scope
    const result: SessionReferenceAccessList = { references: [] as SessionReferenceAccess[], truncated: this.#truncated, depthLimit: SESSION_REFERENCE_CHAIN_DEPTH, countLimit: SESSION_REFERENCE_COUNT_LIMIT }
    if (!root)
      return result
    const current = this.#conversations.findById(root.conversationId)
    if (!current || current.deletedAt || current.activeBranchId !== root.branchId)
      return result
    const blocked = new Map<string, Set<string>>()
    const excludes = (id: string, branchId: string, target: string) => {
      if (!blocked.has(id))
        blocked.set(id, new Set(this.#repository.exclusions(id, branchId)))
      return blocked.get(id)!.has(target)
    }
    const messages = new Map<string, Set<string>>()
    const hasReference = (scope: SessionReferenceScope, messageId: string, id: string) => {
      const key = `${scope.conversationId}:${messageId}`
      if (!messages.has(key))
        messages.set(key, new Set(this.#repository.referenceIds(scope, messageId)))
      return messages.get(key)!.has(id)
    }
    const reachable = new Map<string, number>([[root.conversationId, -1]])
    for (let pass = 0; pass <= SESSION_REFERENCE_CHAIN_DEPTH + 1; pass++) {
      for (const [id, node] of this.#nodes) {
        const target = this.#conversations.findById(id)
        if (!node.scope || !target || target.deletedAt || target.activeBranchId !== node.scope.branchId || excludes(root.conversationId, root.branchId, id))
          continue
        for (const edge of node.edges) {
          const fromDepth = reachable.get(edge.from)
          const fromScope = edge.from === root.conversationId ? root : this.#nodes.get(edge.from)?.scope
          if (fromDepth === undefined || fromDepth >= SESSION_REFERENCE_CHAIN_DEPTH || !fromScope || excludes(edge.from, fromScope.branchId, id) || !hasReference(fromScope, edge.messageId, id))
            continue
          const depth = fromDepth + 1
          if (depth < (reachable.get(id) ?? Number.POSITIVE_INFINITY))
            reachable.set(id, depth)
        }
      }
    }
    for (const [id, node] of this.#nodes) {
      const target = this.#conversations.findById(id)
      const depth = reachable.get(id)
      const status = excludes(root.conversationId, root.branchId, id)
        ? 'revoked'
        : !node.scope || !target || target.deletedAt
            ? 'unavailable'
            : target.activeBranchId !== node.scope.branchId
              ? 'branch_changed'
              : depth === undefined ? 'unavailable' : 'available'
      const via = node.edges.flatMap(edge => edge.from === root.conversationId ? [] : [{ id: edge.from, title: this.#nodes.get(edge.from)?.reference.title ?? edge.from }])
      result.references.push({ ...node.reference, title: target?.title ?? node.reference.title, depth: depth ?? node.reference.depth, via: depth === 0 ? [] : [...new Map(via.map(item => [item.id, item])).values()], status })
    }
    return result
  }
}
