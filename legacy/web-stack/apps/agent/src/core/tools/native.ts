import type { RuntimeToolLoopSession } from './session'
import type { AgentModelCallResult } from './types'
import { AIMessage } from '@langchain/core/messages'
import { shouldContinueWithFinalResponse } from './execution-events'
import { MAX_RUNTIME_TOOL_ROUNDS } from './limits'

export async function runNativeToolProtocol(session: RuntimeToolLoopSession): Promise<AgentModelCallResult> {
  let lastResult = await session.consumeVisibleNativeToolCall()
  session.recordModelCall(lastResult)

  for (let round = 0; round < MAX_RUNTIME_TOOL_ROUNDS && lastResult.toolCalls.length > 0; round += 1) {
    session.appendMessage(new AIMessage({
      content: lastResult.text,
      tool_calls: lastResult.toolCalls,
    }))

    const toolResult = await session.executeSkillActions(lastResult.toolCalls)
    session.appendToolMessages(toolResult.toolMessages)

    const shouldForceFinalResponse = shouldContinueWithFinalResponse({
      toolCalls: lastResult.toolCalls,
      toolMessages: toolResult.toolMessages,
    })

    session.refreshVisibleTools()

    lastResult = shouldForceFinalResponse || round === MAX_RUNTIME_TOOL_ROUNDS - 1 || session.visibleTools.length === 0
      ? await session.consumeFinalResponse()
      : await session.consumeVisibleNativeToolCall()
    session.recordModelCall(lastResult)
  }

  return session.createCallResult(lastResult)
}
