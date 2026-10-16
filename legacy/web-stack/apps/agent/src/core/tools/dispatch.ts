import type { ChatMemoryOperationProjection } from '@haohaoxue/lexora-contracts'
import type { ToolCall } from '@langchain/core/messages'
import type { AgentMemoryApiClient } from '../../clients/memory'
import type { AgentSkillApiClient } from '../../clients/skills'
import type { WebSearchClient } from '../../integrations/web-search'
import type { RuntimeSkillActionProvider } from '../skills/action-providers'
import type { LoadedAgentSkill } from '../skills/activation'
import type { AgentGraphContext } from '../state'
import type { RuntimeSkillActionMetadata, RuntimeToolDescriptor } from './registry'
import { ToolMessage } from '@langchain/core/messages'
import { isGraphInterrupt } from '@langchain/langgraph'
import { createRuntimeToolRegistry } from './registry'

export async function executeRuntimeToolCalls(input: {
  memoryApi?: AgentMemoryApiClient
  skillApi?: AgentSkillApiClient
  webSearch?: WebSearchClient
  skillActionProviders?: readonly RuntimeSkillActionProvider[]
  context: AgentGraphContext
  sessionId: string
  toolCalls: ToolCall[]
  loadedSkills: LoadedAgentSkill[]
  observer?: RuntimeToolExecutionObserver
}): Promise<{
  toolMessages: ToolMessage[]
  operations: ChatMemoryOperationProjection[]
  loadedSkills: LoadedAgentSkill[]
}> {
  const toolMessages: ToolMessage[] = []
  const operations: ChatMemoryOperationProjection[] = []
  let loadedSkills = input.loadedSkills
  let registry = createRuntimeToolRegistry({
    ...input,
    loadedSkills,
  })
  const handledToolCalls = new Set<ToolCall>()

  const preActionToolCalls = input.toolCalls.filter((toolCall) => {
    const descriptor = registry.getDescriptor(toolCall.name)
    return descriptor?.executeBeforeSkillActions === true
  })

  for (const toolCall of preActionToolCalls) {
    const descriptor = registry.getDescriptor(toolCall.name)
    if (!descriptor) {
      continue
    }

    const result = await executeObservedToolCallGroup(input.observer, [toolCall], () =>
      descriptor.execute({
        context: input.context,
        sessionId: input.sessionId,
        toolCalls: [toolCall],
        loadedSkills,
      }), createDescriptorMetadataByActionName(descriptor))
    loadedSkills = result.loadedSkills ?? loadedSkills
    operations.push(...result.memoryOperations ?? [])
    toolMessages.push(...result.toolMessages)
    handledToolCalls.add(toolCall)

    if (descriptor.refreshRegistryAfterExecution) {
      registry = createRuntimeToolRegistry({
        ...input,
        loadedSkills,
      })
    }
  }

  for (const toolCall of input.toolCalls) {
    if (handledToolCalls.has(toolCall)) {
      continue
    }

    const descriptor = registry.getDescriptor(toolCall.name)
    if (!descriptor) {
      continue
    }

    const result = await executeObservedToolCallGroup(input.observer, [toolCall], () =>
      descriptor.execute({
        context: input.context,
        sessionId: input.sessionId,
        toolCalls: [toolCall],
        loadedSkills,
      }), createDescriptorMetadataByActionName(descriptor))
    operations.push(...result.memoryOperations ?? [])
    loadedSkills = result.loadedSkills ?? loadedSkills
    toolMessages.push(...result.toolMessages)
    handledToolCalls.add(toolCall)

    if (descriptor.refreshRegistryAfterExecution) {
      registry = createRuntimeToolRegistry({
        ...input,
        loadedSkills,
      })
    }
  }

  const unavailableToolCalls: ToolCall[] = []
  for (const toolCall of input.toolCalls) {
    if (handledToolCalls.has(toolCall)) {
      continue
    }

    unavailableToolCalls.push(toolCall)
  }

  if (unavailableToolCalls.length > 0) {
    await input.observer?.onToolCallsStarted?.(unavailableToolCalls, new Map())
    const unavailableToolMessages = unavailableToolCalls.map(toolCall => new ToolMessage({
      tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
      status: 'error',
      content: JSON.stringify({
        status: 'failed',
        reason: `Tool is not available in the current skill state: ${toolCall.name}`,
      }),
    }))
    toolMessages.push(...unavailableToolMessages)
    await input.observer?.onToolCallsCompleted?.(unavailableToolCalls, unavailableToolMessages)
  }

  return {
    toolMessages,
    operations,
    loadedSkills,
  }
}

export interface RuntimeToolExecutionObserver {
  onToolCallsStarted?: (
    toolCalls: ToolCall[],
    metadataByActionName: ReadonlyMap<string, RuntimeSkillActionMetadata>,
  ) => Promise<void>
  onToolCallsCompleted?: (toolCalls: ToolCall[], toolMessages: ToolMessage[]) => Promise<void>
  onToolCallsFailed?: (toolCalls: ToolCall[], error: unknown) => Promise<void>
}

async function executeObservedToolCallGroup<TResult extends {
  toolMessages: ToolMessage[]
}>(
  observer: RuntimeToolExecutionObserver | undefined,
  toolCalls: ToolCall[],
  execute: () => Promise<TResult>,
  metadataByActionName: ReadonlyMap<string, RuntimeSkillActionMetadata>,
): Promise<TResult> {
  await observer?.onToolCallsStarted?.(toolCalls, metadataByActionName)

  try {
    const result = await execute()
    await observer?.onToolCallsCompleted?.(toolCalls, result.toolMessages)
    return result
  }
  catch (error) {
    if (!isGraphInterrupt(error)) {
      await observer?.onToolCallsFailed?.(toolCalls, error)
    }

    throw error
  }
}

function createDescriptorMetadataByActionName(
  descriptor: RuntimeToolDescriptor,
): ReadonlyMap<string, RuntimeSkillActionMetadata> {
  return new Map([
    [descriptor.name, {
      skillKey: descriptor.ownerSkillKey,
      connectorType: descriptor.connectorType,
    }],
  ])
}
