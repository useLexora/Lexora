import type { ToolCall } from '@langchain/core/messages'
import type { AgentGraphContext } from '../../../../state'
import { ToolMessage } from '@langchain/core/messages'
import { createCurrentTimeResultFromGraphContext } from './context'
import { GetCurrentTimeToolInputSchema } from './schemas'

export async function executeTimeToolCalls(input: {
  context: AgentGraphContext
  toolCalls: ToolCall[]
}): Promise<{
  toolMessages: ToolMessage[]
}> {
  return {
    toolMessages: input.toolCalls.map((toolCall) => {
      try {
        const args = GetCurrentTimeToolInputSchema.parse(toolCall.args)
        return new ToolMessage({
          tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
          content: JSON.stringify(createCurrentTimeResultFromGraphContext({
            context: input.context,
            requestedTimeZone: args.timeZone,
          })),
        })
      }
      catch (error) {
        return new ToolMessage({
          tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
          status: 'error',
          content: JSON.stringify({
            status: 'failed',
            reason: error instanceof Error && error.message.trim()
              ? error.message.trim()
              : 'Failed to read current time.',
          }),
        })
      }
    }),
  }
}
