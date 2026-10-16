import type { BaseMessage } from '@langchain/core/messages'
import type { AgentChatModel } from '../../integrations/model-providers/chat-model'
import type { AgentModelStreamPart } from '../../integrations/model-providers/stream-text'
import type { AgentGraphContext } from '../state'
import type { StreamingModelCallResult } from './model-call'
import { HumanMessage } from '@langchain/core/messages'
import { consumeStreamingModelCall } from './model-call'

const FINAL_RESPONSE_INSTRUCTION = [
  '[Lexora 最终回答阶段]',
  '本轮工具调用已经执行完毕。请只基于上面的工具结果，直接写给用户看的自然语言最终回答。',
  '即使工具结果不足以给出完整结论，也必须说明已经获取到的信息和仍然缺少的信息，不得留空。',
  '不要输出 <tool_calls>、DSML、XML 工具调用、JSON 函数调用，也不要要求继续调用工具。',
  '[Lexora 最终回答阶段结束]',
].join('\n')

const FINAL_RESPONSE_REPAIR_INSTRUCTION = [
  '[Lexora 最终回答修复]',
  '上一次最终回答仍包含内部工具调用协议，系统已丢弃该输出。',
  '现在必须基于已有工具结果给用户写至少一句自然语言总结。信息不足时直接说明不足，不要留空。',
  '不要再输出任何工具调用协议。',
  '[Lexora 最终回答修复结束]',
].join('\n')

const FINAL_RESPONSE_FALLBACK_TEXT = '我已完成工具查询，但当前结果不足以形成可靠结论；请参考上方工具结果，或稍后重试。'

export async function consumeFinalStreamingModelCall(
  model: AgentChatModel,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  context: AgentGraphContext | undefined,
): Promise<StreamingModelCallResult> {
  const firstAttempt = await consumeBufferedStreamingModelCall(
    model,
    appendFinalResponseInstruction(messages, FINAL_RESPONSE_INSTRUCTION),
    signal,
  )

  if (!shouldRepairFinalResponse(firstAttempt)) {
    await emitBufferedStreamParts(firstAttempt.streamParts, context)
    return {
      ...toStreamingModelCallResult(firstAttempt),
      toolCalls: [],
    }
  }

  const repairedAttempt = await consumeBufferedStreamingModelCall(
    model,
    appendFinalResponseInstruction(messages, FINAL_RESPONSE_REPAIR_INSTRUCTION),
    signal,
  )

  if (!shouldRepairFinalResponse(repairedAttempt) || repairedAttempt.text.trim()) {
    await emitBufferedStreamParts(repairedAttempt.streamParts, context)
    return {
      ...mergeFinalResponseAttempts(
        toStreamingModelCallResult(firstAttempt),
        toStreamingModelCallResult(repairedAttempt),
      ),
      toolCalls: [],
    }
  }

  await context?.onStreamPart?.({
    type: 'text.delta',
    text: FINAL_RESPONSE_FALLBACK_TEXT,
  })

  return {
    ...mergeFinalResponseAttempts(toStreamingModelCallResult(firstAttempt), {
      ...toStreamingModelCallResult(repairedAttempt),
      text: FINAL_RESPONSE_FALLBACK_TEXT,
    }),
    toolCalls: [],
  }
}

async function consumeBufferedStreamingModelCall(
  model: AgentChatModel,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
): Promise<BufferedStreamingModelCallResult> {
  const streamParts: AgentModelStreamPart[] = []
  const result = await consumeStreamingModelCall(model, messages, signal, {
    onStreamPart(part) {
      streamParts.push(part)
    },
  })

  return {
    ...result,
    streamParts,
  }
}

async function emitBufferedStreamParts(
  parts: AgentModelStreamPart[],
  context: AgentGraphContext | undefined,
): Promise<void> {
  for (const part of parts) {
    await context?.onStreamPart?.(part)
  }
}

type BufferedStreamingModelCallResult = StreamingModelCallResult & {
  streamParts: AgentModelStreamPart[]
}

function toStreamingModelCallResult(result: BufferedStreamingModelCallResult): StreamingModelCallResult {
  const { streamParts: _streamParts, ...modelCallResult } = result
  return modelCallResult
}

function appendFinalResponseInstruction(messages: BaseMessage[], instruction: string): BaseMessage[] {
  return [
    ...messages,
    new HumanMessage({
      content: instruction,
    }),
  ]
}

function shouldRepairFinalResponse(result: StreamingModelCallResult): boolean {
  return !result.text.trim() || result.suppressedToolCallBlockCount > 0 || result.toolCalls.length > 0
}

function mergeFinalResponseAttempts(
  firstAttempt: StreamingModelCallResult,
  finalAttempt: StreamingModelCallResult,
): StreamingModelCallResult {
  return {
    ...finalAttempt,
    providerUsage: mergeFinalProviderUsage(firstAttempt.providerUsage, finalAttempt.providerUsage),
    firstTokenLatencyMs: finalAttempt.firstTokenLatencyMs === undefined
      ? undefined
      : firstAttempt.elapsedMs + finalAttempt.firstTokenLatencyMs,
    elapsedMs: firstAttempt.elapsedMs + finalAttempt.elapsedMs,
    suppressedToolCallBlockCount: firstAttempt.suppressedToolCallBlockCount + finalAttempt.suppressedToolCallBlockCount,
  }
}

function mergeFinalProviderUsage(
  firstUsage: StreamingModelCallResult['providerUsage'],
  finalUsage: StreamingModelCallResult['providerUsage'],
): StreamingModelCallResult['providerUsage'] {
  if (!firstUsage) {
    return finalUsage
  }

  if (!finalUsage) {
    return firstUsage
  }

  return {
    inputTokens: sumOptionalNumbers(firstUsage.inputTokens, finalUsage.inputTokens),
    outputTokens: sumOptionalNumbers(firstUsage.outputTokens, finalUsage.outputTokens),
    totalTokens: sumOptionalNumbers(firstUsage.totalTokens, finalUsage.totalTokens),
    reasoningTokens: sumOptionalNumbers(firstUsage.reasoningTokens, finalUsage.reasoningTokens),
  }
}

function sumOptionalNumbers(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) {
    return second
  }

  if (second === undefined) {
    return first
  }

  return first + second
}
