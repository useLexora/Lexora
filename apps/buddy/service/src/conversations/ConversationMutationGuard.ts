import { BuddyServiceError } from '../rpc/runtimeRequest'

export class ConversationMutationGuard {
  readonly #changing = new Set<string>()

  assertWritable(conversationId: string): void {
    if (this.#changing.has(conversationId))
      throw new BuddyServiceError('CONVERSATION_BUSY')
  }

  async run<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    this.assertWritable(conversationId)
    this.#changing.add(conversationId)
    try {
      return await operation()
    }
    finally {
      this.#changing.delete(conversationId)
    }
  }
}
