import type { BaseMessage, ToolCall, ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentChatModel } from '../../integrations/model-providers/chat-model'
import type { AgentModelTextStreamResult } from '../../integrations/model-providers/stream-text'
import type { RuntimeToolLoopSession } from './session'
import type { AgentModelCallResult } from './types'
import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { consumeChatModelTextStream } from '../../integrations/model-providers/stream-text'
import { shouldContinueWithFinalResponse } from './execution-events'
import { MAX_RUNTIME_TOOL_ROUNDS } from './limits'
import {
  formatToolExecutionError,
  getToolCallId,
} from './utils'

const StructuredJsonToolCallSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
}).strict()

const StructuredJsonToolDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool_calls'),
    toolCalls: z.array(StructuredJsonToolCallSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal('final_answer'),
    answer: z.string(),
  }).strict(),
])

type StructuredJsonToolDecision = z.infer<typeof StructuredJsonToolDecisionSchema>
type StructuredJsonToolCallsDecision = Extract<StructuredJsonToolDecision, { kind: 'tool_calls' }>

export async function runStructuredJsonToolProtocol(session: RuntimeToolLoopSession): Promise<AgentModelCallResult> {
  for (let round = 0; round < MAX_RUNTIME_TOOL_ROUNDS && session.visibleTools.length > 0; round += 1) {
    const selection = await consumeStructuredJsonToolDecisionWithRepair({
      model: session.model,
      messages: session.messages,
      tools: session.visibleTools,
      signal: session.signal,
    })
    for (const result of selection.results) {
      session.recordModelCall(result)
    }

    if (selection.decision.kind === 'final_answer') {
      await emitStructuredFinalAnswer(session, selection.decision.answer)
      return session.createCallResult({
        ...selection.result,
        text: selection.decision.answer,
        toolCalls: [],
      })
    }

    const toolCalls = normalizeStructuredJsonToolCalls(selection.decision.toolCalls, round)
    assertStructuredJsonToolCallsAreVisible(toolCalls, session.visibleTools)

    const toolResult = await session.executeSkillActions(toolCalls)
    session.appendMessage(createStructuredJsonToolResultMessage({
      toolCalls,
      toolMessages: toolResult.toolMessages,
    }))

    const shouldForceFinalResponse = shouldContinueWithFinalResponse({
      toolCalls,
      toolMessages: toolResult.toolMessages,
    })

    session.refreshVisibleTools()

    if (shouldForceFinalResponse || round === MAX_RUNTIME_TOOL_ROUNDS - 1 || session.visibleTools.length === 0) {
      const finalResult = await session.consumeFinalResponse()
      session.recordModelCall(finalResult)
      return session.createCallResult(finalResult)
    }
  }

  const finalResult = await session.consumeFinalResponse()
  session.recordModelCall(finalResult)
  return session.createCallResult(finalResult)
}

async function consumeStructuredJsonToolDecisionText(input: {
  model: AgentChatModel
  messages: BaseMessage[]
  tools: StructuredToolInterface[]
  signal?: AbortSignal
}): Promise<AgentModelTextStreamResult> {
  const stream = await input.model.stream(createStructuredJsonToolDecisionMessages(input.messages, input.tools), {
    signal: input.signal,
  })
  return consumeChatModelTextStream(stream)
}

async function consumeStructuredJsonToolDecisionWithRepair(input: {
  model: AgentChatModel
  messages: BaseMessage[]
  tools: StructuredToolInterface[]
  signal?: AbortSignal
}): Promise<{
  result: AgentModelTextStreamResult
  results: AgentModelTextStreamResult[]
  decision: StructuredJsonToolDecision
}> {
  const results: AgentModelTextStreamResult[] = []
  let messages = input.messages
  let lastError: unknown = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: AgentModelTextStreamResult
    let decision: StructuredJsonToolDecision
    try {
      result = await consumeStructuredJsonToolDecisionText({
        ...input,
        messages,
      })
      results.push(result)
      decision = parseStructuredJsonToolDecision(result.text)
    }
    catch (error) {
      lastError = error
      messages = appendStructuredJsonToolDecisionRepairInstruction(input.messages, error)
      continue
    }

    try {
      assertStructuredJsonDecisionToolCallsAreVisible(decision, input.tools)
      return {
        result,
        decision,
        results,
      }
    }
    catch (error) {
      lastError = error
      messages = appendStructuredJsonToolDecisionRepairInstruction(input.messages, error)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('结构化工具选择重试失败')
}

function createStructuredJsonToolDecisionMessages(
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
): BaseMessage[] {
  return [
    ...messages,
    new HumanMessage({
      content: [
        '[Lexora 结构化工具选择]',
        '你必须只输出一个 JSON 对象，不要输出 Markdown、解释或自然语言前后缀。',
        '如果需要调用工具，输出 {"kind":"tool_calls","toolCalls":[{"id":"...","name":"工具名","args":{}}]}。',
        '如果不需要调用工具，输出 {"kind":"final_answer","answer":"给用户看的自然语言回复"}。',
        '只允许调用 availableTools 中列出的工具，args 必须符合对应 inputSchema。',
        `availableTools: ${JSON.stringify(toStructuredJsonToolDescriptors(tools))}`,
        '[Lexora 结构化工具选择结束]',
      ].join('\n'),
    }),
  ]
}

function toStructuredJsonToolDescriptors(tools: StructuredToolInterface[]): Array<{
  name: string
  description?: string
  inputSchema?: unknown
}> {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.schema),
  }))
}

function toJsonSchema(schema: StructuredToolInterface['schema']): unknown {
  try {
    const jsonSchema = z.toJSONSchema(schema as z.ZodType)
    return omitJsonSchemaDialect(jsonSchema)
  }
  catch {
    return undefined
  }
}

function omitJsonSchemaDialect(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema
  }

  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>
  return rest
}

function parseStructuredJsonToolDecision(text: string): StructuredJsonToolDecision {
  const rawJson = extractJsonObjectText(text)
  if (!rawJson) {
    throw new Error('模型未返回有效的结构化工具选择 JSON')
  }

  try {
    return StructuredJsonToolDecisionSchema.parse(JSON.parse(rawJson))
  }
  catch (error) {
    throw new Error(`模型返回的结构化工具选择不符合协议: ${formatToolExecutionError(error)}`)
  }
}

function extractJsonObjectText(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }

  const fencedBody = extractJsonFenceBody(trimmed)
  if (fencedBody?.startsWith('{') && fencedBody.endsWith('}')) {
    return fencedBody
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  return firstBrace >= 0 && lastBrace > firstBrace
    ? trimmed.slice(firstBrace, lastBrace + 1)
    : null
}

function extractJsonFenceBody(text: string): string | null {
  if (!text.startsWith('```')) {
    return null
  }

  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) {
    return null
  }

  const fenceLanguage = text.slice(3, firstLineEnd).trim().toLowerCase()
  if (fenceLanguage && fenceLanguage !== 'json') {
    return null
  }

  const closingFenceStart = text.lastIndexOf('```')
  return closingFenceStart > firstLineEnd
    ? text.slice(firstLineEnd + 1, closingFenceStart).trim()
    : null
}

function normalizeStructuredJsonToolCalls(
  toolCalls: StructuredJsonToolCallsDecision['toolCalls'],
  round: number,
): ToolCall[] {
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id ?? `structured_tool_call_${round + 1}_${index + 1}`,
    name: toolCall.name,
    args: toolCall.args,
  }))
}

function assertStructuredJsonToolCallsAreVisible(
  toolCalls: ToolCall[],
  tools: StructuredToolInterface[],
): void {
  const visibleToolNames = new Set(tools.map(tool => tool.name))
  const invalidToolCall = toolCalls.find(toolCall => !visibleToolNames.has(toolCall.name))
  if (invalidToolCall) {
    throw new Error(`结构化工具选择调用了当前不可见的工具: ${invalidToolCall.name}`)
  }
}

function assertStructuredJsonDecisionToolCallsAreVisible(
  decision: StructuredJsonToolDecision,
  tools: StructuredToolInterface[],
): void {
  if (decision.kind !== 'tool_calls') {
    return
  }

  const visibleToolNames = new Set(tools.map(tool => tool.name))
  const invalidToolCall = decision.toolCalls.find(toolCall => !visibleToolNames.has(toolCall.name))
  if (invalidToolCall) {
    throw new Error(`结构化工具选择调用了当前不可见的工具: ${invalidToolCall.name}`)
  }
}

function appendStructuredJsonToolDecisionRepairInstruction(
  messages: BaseMessage[],
  error: unknown,
): BaseMessage[] {
  return [
    ...messages,
    new HumanMessage({
      content: [
        '[Lexora 结构化工具选择修复]',
        `上一次结构化工具选择不可执行：${formatToolExecutionError(error)}`,
        '请重新只输出一个符合协议的 JSON 对象；不要输出 Markdown、解释或自然语言前后缀。',
        '[Lexora 结构化工具选择修复结束]',
      ].join('\n'),
    }),
  ]
}

async function emitStructuredFinalAnswer(
  session: RuntimeToolLoopSession,
  text: string,
): Promise<void> {
  if (text) {
    await session.context?.onStreamPart?.({
      type: 'text.delta',
      text,
    })
  }
}

function createStructuredJsonToolResultMessage(input: {
  toolCalls: ToolCall[]
  toolMessages: ToolMessage[]
}): HumanMessage {
  return new HumanMessage({
    content: [
      '[Lexora 工具执行结果]',
      '上一轮结构化工具选择已经执行。下面是工具调用与结果，请基于这些结果继续选择下一步或给出最终回答。',
      JSON.stringify({
        toolCalls: input.toolCalls.map(toolCall => ({
          id: getToolCallId(toolCall),
          name: toolCall.name,
          args: toolCall.args,
        })),
        toolResults: input.toolMessages.map(message => ({
          toolCallId: message.tool_call_id,
          status: message.status ?? 'success',
          content: message.content,
        })),
      }, null, 2),
      '[Lexora 工具执行结果结束]',
    ].join('\n'),
  })
}
