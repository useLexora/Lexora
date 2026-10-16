import type { ToolCall } from '@langchain/core/messages'
import type { AgentGraphContext } from '../../../../state'
import { ToolMessage } from '@langchain/core/messages'
import {
  createCurrentLocationResultFromGraphContext,
} from './context'
import { GetCurrentLocationToolInputSchema } from './schemas'

export async function executeLocationToolCalls(input: {
  context: AgentGraphContext
  toolCalls: ToolCall[]
}): Promise<{
  toolMessages: ToolMessage[]
}> {
  const toolMessages: ToolMessage[] = []

  for (const toolCall of input.toolCalls) {
    toolMessages.push(await executeLocationToolCall(input.context, toolCall))
  }

  return {
    toolMessages,
  }
}

async function executeLocationToolCall(
  context: AgentGraphContext,
  toolCall: ToolCall,
): Promise<ToolMessage> {
  const toolCallId = toolCall.id ?? `${toolCall.name}:missing-id`

  try {
    GetCurrentLocationToolInputSchema.parse(toolCall.args)

    return new ToolMessage({
      tool_call_id: toolCallId,
      content: JSON.stringify(await createCurrentLocationResultFromGraphContext({ context })),
    })
  }
  catch (error) {
    return new ToolMessage({
      tool_call_id: toolCallId,
      status: 'error',
      content: JSON.stringify({
        status: 'failed',
        reason: error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to read current location.',
      }),
    })
  }
}
