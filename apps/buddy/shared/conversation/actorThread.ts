export function actorThreadId(conversationId: string, actorId: string): string {
  return `actor:${JSON.stringify([conversationId, actorId])}`
}
