import type { BuddyInlineNodeV1, BuddyMessageQuote, BuddyResourceQuote, BuddySessionReference, BuddyUserContentV1 } from './buddyUserContent'

export type BuddyInputMaterial
  = | { kind: 'resource', id: string }
    | { kind: 'message_quote', id: string, quote: BuddyMessageQuote }
    | { kind: 'resource_quote', id: string, quote: BuddyResourceQuote }
    | { kind: 'session', id: string, reference: BuddySessionReference }

export type BuddyQuoteReference = Extract<BuddyInlineNodeV1, { type: 'quote_ref' }>

export function buddyInputMaterialKey(material: Pick<BuddyInputMaterial, 'kind' | 'id'>): string {
  return `${material.kind}:${material.id}`
}

export function getBuddyInputMaterials(content: BuddyUserContentV1): BuddyInputMaterial[] {
  const materials = new Map<string, BuddyInputMaterial>()
  const available = new Map<string, BuddyInputMaterial>([
    ...(content.quotes ?? []).map(quote => [`message_quote:${quote.id}`, { kind: 'message_quote', id: quote.id, quote }] as const),
    ...(content.resourceQuotes ?? []).map(quote => [`resource_quote:${quote.id}`, { kind: 'resource_quote', id: quote.id, quote }] as const),
    ...(content.sessionReferences ?? []).map(reference => [`session:${reference.id}`, { kind: 'session', id: reference.id, reference }] as const),
  ])
  const add = (material: BuddyInputMaterial) => materials.set(buddyInputMaterialKey(material), material)
  const inlineResources = new Set(content.body.flatMap(paragraph => paragraph.content.flatMap(node => node.type === 'resource_ref' ? [node.resourceId] : [])))
  content.panelResourceIds.filter(id => !inlineResources.has(id)).forEach(id => add({ kind: 'resource', id }))
  for (const paragraph of content.body) {
    for (const node of paragraph.content) {
      if (node.type === 'resource_ref') {
        add({ kind: 'resource', id: node.resourceId })
        continue
      }
      const key = node.type === 'session_ref' ? `session:${node.sessionId}` : node.type === 'quote_ref' ? `${node.quoteKind}_quote:${node.quoteId}` : null
      const material = key ? available.get(key) : undefined
      if (material)
        add(material)
    }
  }
  available.forEach(material => add(material))
  return [...materials.values()]
}

export function resolveBuddyQuoteReference(content: BuddyUserContentV1, reference: BuddyQuoteReference) {
  return getBuddyInputMaterials(content).find(material => material.kind === `${reference.quoteKind}_quote` && material.id === reference.quoteId)
}
