export function createDirectTranslatorThreadId(threadId: string, generationId: string): string {
  return `${threadId}:translator:${generationId}`
}
