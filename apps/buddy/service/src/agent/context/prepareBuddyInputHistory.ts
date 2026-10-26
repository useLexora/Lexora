import type { UserMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { hasPublicMaterialContent, PUBLIC_CONTEXT_TYPE, publicConversationMaterialSchema } from '../../conversations/publicConversationContext'
import { readBuddyInputReference } from './BuddyInputReference'
import { projectReadResult } from './projectReadHistory'

export function isRejectedModelInput(code: unknown): code is string {
  return code === 'MODEL_INPUT_TOO_LARGE'
}

export function rejectedBuddyInputMessage(message: UserMessage, code: string): UserMessage {
  const input = readBuddyInputReference(message)
  const prompt = input?.prompt ?? (typeof message.content === 'string'
    ? message.content
    : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  return {
    role: 'user',
    content: `${prompt}\n\n[This input was rejected before reaching the model (${code}). Its attachments are unavailable in this context. The original message can be edited or retried.]`,
    timestamp: message.timestamp,
  }
}

export function prepareBuddyInputHistory(messages: readonly AgentSession['messages'][number][]): AgentSession['messages'] {
  const result: AgentSession['messages'] = []
  let pendingUsers: number[] = []
  for (const message of messages) {
    if (message.role === 'custom' && message.customType === PUBLIC_CONTEXT_TYPE) {
      const material = publicConversationMaterialSchema.safeParse(message.details)
      if (material.success && !hasPublicMaterialContent(material.data))
        continue
    }
    if (message.role === 'user')
      pendingUsers.push(result.length)
    if (message.role === 'assistant') {
      if (message.stopReason === 'error' && !message.content.length && isRejectedModelInput(message.errorMessage)) {
        for (const index of pendingUsers) {
          const input = result[index]
          if (input?.role === 'user')
            result[index] = rejectedBuddyInputMessage(input, message.errorMessage)
        }
        pendingUsers = []
        continue
      }
      if (message.stopReason !== 'error' || message.content.length > 0)
        pendingUsers = []
    }
    result.push(message.role === 'toolResult' ? projectReadResult(message) : message)
  }
  return result
}
