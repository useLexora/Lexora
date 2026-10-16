import type { BaseMessage } from '@langchain/core/messages'
import type { AgentChatModel } from '../../integrations/model-providers/chat-model'
import type { AgentGraphContext } from '../state'
import type { AgentModelCallResult } from './types'
import { consumeChatModelTextStream } from '../../integrations/model-providers/stream-text'

export type StreamingModelCallResult = Awaited<ReturnType<typeof consumeStreamingModelCall>>

export async function streamModelWithoutTools(input: {
  model: AgentChatModel
  messages: BaseMessage[]
  context: AgentGraphContext | undefined
  signal?: AbortSignal
}): Promise<AgentModelCallResult> {
  const stream = await input.model.stream(input.messages, {
    signal: input.signal,
  })

  return consumeChatModelTextStream(stream, {
    onStreamPart: input.context?.onStreamPart,
  }).then(result => ({
    ...result,
    memoryOperations: [],
  }))
}

export async function consumeStreamingModelCall(
  model: AgentChatModel,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  context: Pick<AgentGraphContext, 'onStreamPart'> | undefined,
) {
  const stream = await model.stream(messages, { signal })
  return consumeChatModelTextStream(stream, {
    onStreamPart: context?.onStreamPart,
  })
}
