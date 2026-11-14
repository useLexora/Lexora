export function actorThreadId(conversationId: string, actorId: string, branchId?: string): string {
  return `actor:${JSON.stringify(branchId ? [conversationId, actorId, branchId] : [conversationId, actorId])}`
}
