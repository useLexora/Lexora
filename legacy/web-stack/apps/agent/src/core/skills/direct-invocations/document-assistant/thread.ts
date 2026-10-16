export function createDirectDocumentAssistantThreadId(threadId: string, generationId: string): string {
  return `${threadId}:document-assistant:${generationId}`
}
