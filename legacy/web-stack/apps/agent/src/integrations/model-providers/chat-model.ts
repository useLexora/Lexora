import type { BaseMessage, MessageContent } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ChatOpenAICallOptions } from '@langchain/openai'
import type { AgentRuntimeModelTarget } from '../../runtime/typing'
import { AI_PROVIDER_AUTH_MODE } from '@haohaoxue/lexora-contracts'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'

const MODEL_CALL_TIMEOUT_MS = 60_000
const OPENAI_COMPATIBLE_USER_AGENT = 'Lexora-Agent/1.0'
const STAINLESS_HEADER_PREFIX = 'x-stainless-'

export interface AgentChatModel {
  stream: (messages: BaseMessage[], options?: { signal?: AbortSignal }) => Promise<AsyncIterable<AgentChatModelResponse>>
  bindTools?: (
    tools: StructuredToolInterface[],
    options?: { tool_choice?: 'auto' | 'any' | 'none' | string },
  ) => AgentChatModel
}

export interface AgentChatModelResponse {
  content: MessageContent
  usage_metadata?: unknown
  response_metadata?: unknown
}

export interface AgentChatModelOptions {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
}

interface BindableChatModel {
  stream: AgentChatModel['stream']
  bindTools?: (
    tools: StructuredToolInterface[],
    options?: { tool_choice?: 'auto' | 'any' | 'none' | string },
  ) => BindableChatModel
}

export interface AgentChatModelFactory {
  createChatModel: (target: AgentRuntimeModelTarget, options?: AgentChatModelOptions) => AgentChatModel
}

export function createChatModelFactory(): AgentChatModelFactory {
  return {
    createChatModel(target, options = {}) {
      ensureCredentialReady(target)

      switch (target.adapterKey) {
        case 'openai-chat-completions':
          return createOpenAIChatModel(target, options)
        case 'anthropic-messages':
          return toAgentChatModel(new ChatAnthropic({
            model: target.modelId,
            temperature: options.temperature ?? 0,
            topP: options.topP,
            maxTokens: options.maxOutputTokens,
            maxRetries: 1,
            apiKey: target.apiKey ?? 'lexora-no-auth',
            anthropicApiUrl: target.endpoint,
          }) as BindableChatModel)
        default:
          throw new Error(`暂不支持的模型适配器: ${target.adapterKey}`)
      }
    },
  }
}

function createOpenAIChatModel(target: AgentRuntimeModelTarget, options: AgentChatModelOptions): AgentChatModel {
  const model = new ChatOpenAI({
    model: target.modelId,
    temperature: options.temperature ?? 0,
    topP: options.topP,
    maxTokens: options.maxOutputTokens,
    timeout: MODEL_CALL_TIMEOUT_MS,
    maxRetries: 1,
    apiKey: target.apiKey ?? 'lexora-no-auth',
    configuration: {
      baseURL: target.endpoint,
      defaultHeaders: {
        'User-Agent': OPENAI_COMPATIBLE_USER_AGENT,
      },
      fetch: createOpenAICompatibleFetch(),
    },
    useResponsesApi: false,
  })

  return toAgentChatModel(model, options.reasoningEffort
    ? streamOptions => ({
      ...streamOptions,
      reasoningEffort: options.reasoningEffort,
    })
    : undefined)
}

function toAgentChatModel(
  model: BindableChatModel,
  createCallOptions?: (options?: { signal?: AbortSignal }) => ChatOpenAICallOptions,
): AgentChatModel {
  return {
    async stream(messages, streamOptions) {
      return await model.stream(messages, createCallOptions?.(streamOptions) ?? streamOptions)
    },
    bindTools: model.bindTools
      ? (tools, bindOptions) => toAgentChatModel(model.bindTools?.(tools, bindOptions) ?? model, createCallOptions)
      : undefined,
  }
}

function createOpenAICompatibleFetch(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('User-Agent', OPENAI_COMPATIBLE_USER_AGENT)

    for (const headerName of [...headers.keys()]) {
      if (headerName.toLowerCase().startsWith(STAINLESS_HEADER_PREFIX)) {
        headers.delete(headerName)
      }
    }

    return fetch(input, {
      ...init,
      headers,
    })
  }
}

function ensureCredentialReady(target: AgentRuntimeModelTarget): void {
  if (target.authMode !== AI_PROVIDER_AUTH_MODE.NONE && !target.apiKey) {
    throw new Error('服务商未提供 API Key')
  }
}
