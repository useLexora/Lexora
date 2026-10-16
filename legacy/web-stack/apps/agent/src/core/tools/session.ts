import type { ChatMemoryOperationProjection } from '@haohaoxue/lexora-contracts'
import type { BaseMessage, ToolCall, ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentMemoryApiClient } from '../../clients/memory'
import type { AgentSkillApiClient } from '../../clients/skills'
import type { AgentChatModel } from '../../integrations/model-providers/chat-model'
import type { WebSearchClient } from '../../integrations/web-search'
import type { RuntimeSkillActionProvider } from '../skills/action-providers'
import type { LoadedAgentSkill } from '../skills/activation'
import type { AgentGraphContext } from '../state'
import type { ToolProtocolUnavailableReason } from './execution-events'
import type { StreamingModelCallResult } from './model-call'
import type { AgentModelCallResult } from './types'
import {
  emitToolProtocolUnavailableWarning,
  executeRuntimeToolCallsWithEvents,
} from './execution-events'
import { consumeFinalStreamingModelCall } from './final-response'
import {
  addModelCallMetrics,
  createAggregatedModelCallMetrics,
} from './metrics'
import {
  consumeStreamingModelCall,
  streamModelWithoutTools,
} from './model-call'
import { createRuntimeToolRegistry } from './registry'

export interface RuntimeToolLoopInput {
  model: AgentChatModel
  messages: BaseMessage[]
  sessionId: string
  context: AgentGraphContext | undefined
  memoryApi?: AgentMemoryApiClient
  skillApi?: AgentSkillApiClient
  webSearch?: WebSearchClient
  skillActionProviders?: readonly RuntimeSkillActionProvider[]
  signal?: AbortSignal
}

export class RuntimeToolLoopSession {
  readonly model: AgentChatModel
  readonly messages: BaseMessage[]
  readonly sessionId: string
  readonly context: AgentGraphContext | undefined
  readonly signal: AbortSignal | undefined

  private readonly memoryApi: AgentMemoryApiClient | undefined
  private readonly skillApi: AgentSkillApiClient | undefined
  private readonly webSearch: WebSearchClient | undefined
  private readonly skillActionProviders: readonly RuntimeSkillActionProvider[] | undefined
  private readonly metrics = createAggregatedModelCallMetrics()
  private readonly memoryOperations: ChatMemoryOperationProjection[] = []
  private loadedSkills: LoadedAgentSkill[] = []
  private tools: StructuredToolInterface[]

  constructor(input: RuntimeToolLoopInput) {
    this.model = input.model
    this.messages = [...input.messages]
    this.sessionId = input.sessionId
    this.context = input.context
    this.signal = input.signal
    this.memoryApi = input.memoryApi
    this.skillApi = input.skillApi
    this.webSearch = input.webSearch
    this.skillActionProviders = input.skillActionProviders
    const registry = this.resolveRuntimeToolRegistry()
    this.tools = registry.tools
  }

  get visibleTools(): StructuredToolInterface[] {
    return this.tools
  }

  recordModelCall(result: StreamingModelCallResult): void {
    addModelCallMetrics(this.metrics, result)
  }

  appendMessage(message: BaseMessage): void {
    this.messages.push(message)
  }

  appendToolMessages(messages: ToolMessage[]): void {
    this.messages.push(...messages)
  }

  async consumeVisibleNativeToolCall(): Promise<StreamingModelCallResult> {
    if (!this.model.bindTools) {
      throw new Error('Native tool binding is unavailable for this model')
    }

    return consumeStreamingModelCall(
      this.model.bindTools(this.tools, { tool_choice: 'auto' }),
      this.messages,
      this.signal,
      this.context,
    )
  }

  async consumeFinalResponse(): Promise<StreamingModelCallResult> {
    return consumeFinalStreamingModelCall(this.model, this.messages, this.signal, this.context)
  }

  async executeSkillActions(toolCalls: ToolCall[]) {
    const result = await executeRuntimeToolCallsWithEvents({
      memoryApi: this.memoryApi,
      webSearch: this.webSearch,
      skillApi: this.skillApi,
      skillActionProviders: this.skillActionProviders,
      context: this.context,
      sessionId: this.sessionId,
      toolCalls,
      loadedSkills: this.loadedSkills,
    })

    this.loadedSkills = result.loadedSkills
    this.memoryOperations.push(...result.operations)
    return result
  }

  refreshVisibleTools(): void {
    const registry = this.resolveRuntimeToolRegistry()
    this.tools = registry.tools
  }

  async warnToolProtocolUnavailable(reason: ToolProtocolUnavailableReason): Promise<void> {
    await emitToolProtocolUnavailableWarning({
      context: this.context,
      reason,
      visibleToolCount: this.tools.length,
    })
  }

  async streamWithoutTools(): Promise<AgentModelCallResult> {
    return streamModelWithoutTools({
      model: this.model,
      messages: this.messages,
      context: this.context,
      signal: this.signal,
    })
  }

  createCallResult(result: StreamingModelCallResult): AgentModelCallResult {
    return {
      ...result,
      providerUsage: this.metrics.providerUsage,
      firstTokenLatencyMs: this.metrics.firstTokenLatencyMs,
      elapsedMs: this.metrics.elapsedMs,
      memoryOperations: this.memoryOperations,
    }
  }

  private resolveRuntimeToolRegistry() {
    return createRuntimeToolRegistry({
      context: this.context,
      memoryApi: this.memoryApi,
      webSearch: this.webSearch,
      skillApi: this.skillApi,
      skillActionProviders: this.skillActionProviders,
      loadedSkills: this.loadedSkills,
    })
  }
}
