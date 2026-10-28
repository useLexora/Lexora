import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { EXECUTION_DELEGATION_TOOL_NAME } from '../../../../shared/executions/executionApi'
import { readCheckpoint } from '../sessions/tree/BuddyTreeStore'

const forwardCall = z.object({
  operation: z.literal('forward'),
  runId: z.string().min(1),
  inputSourceId: z.string().min(1),
}).strict()

const closedReceipt = z.object({
  status: z.literal('closed'),
  replayed: z.literal(false),
  origin: z.literal('user'),
  runId: z.string(),
  inputRunId: z.string(),
  inputSourceId: z.string(),
  messageId: z.string(),
})

export function readClosedForwardTargets(entries: readonly SessionEntry[], callerId: string, input: { sourceId: string, messageId: string }): Set<string> {
  const targets = new Set<string>()
  const calls = new Map<string, z.infer<typeof forwardCall>>()
  let runId: string | null = null
  for (const entry of entries) {
    const checkpoint = readCheckpoint(entry)
    if (checkpoint) {
      runId = checkpoint.position === 'before' ? checkpoint.runId : null
      calls.clear()
    }
    if (runId !== callerId || entry.type !== 'message')
      continue
    const message = entry.message
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'toolCall' || block.name !== EXECUTION_DELEGATION_TOOL_NAME)
          continue
        const parsed = forwardCall.safeParse(block.arguments)
        if (parsed.success && parsed.data.inputSourceId === input.sourceId)
          calls.set(block.id, parsed.data)
      }
    }
    if (message.role !== 'toolResult')
      continue
    const call = calls.get(message.toolCallId)
    calls.delete(message.toolCallId)
    if (!call || message.isError || message.toolName !== EXECUTION_DELEGATION_TOOL_NAME
      || message.content.length !== 1 || message.content[0]?.type !== 'text'
      || message.content[0].text !== JSON.stringify(message.details)) {
      continue
    }
    const parsed = closedReceipt.safeParse(message.details)
    if (parsed.success && parsed.data.inputRunId === callerId && parsed.data.messageId === input.messageId
      && parsed.data.inputSourceId === input.sourceId && parsed.data.runId === call.runId) {
      targets.add(call.runId)
    }
  }
  return targets
}
