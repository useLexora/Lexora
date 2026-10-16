import type { ChatMemoryOperationProjection } from '@haohaoxue/lexora-contracts'
import type { AgentSkillConnectorType } from '@haohaoxue/lexora-contracts/agent'
import type { ToolCall, ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentMemoryApiClient } from '../../clients/memory'
import type { AgentSkillApiClient } from '../../clients/skills'
import type { WebSearchClient } from '../../integrations/web-search'
import type { RuntimeSkillActionProvider, RuntimeSkillActionProviderServices } from '../skills/action-providers'
import type { LoadedAgentSkill } from '../skills/activation'
import type { AgentGraphContext } from '../state'
import { AGENT_SKILL_ACTIVATION_MODE, AGENT_SKILL_CONNECTOR_TYPE } from '@haohaoxue/lexora-contracts'
import { DEFAULT_RUNTIME_SKILL_ACTION_PROVIDERS } from '../skills/action-providers'
import {
  createAgentSkillTools,
  executeAgentSkillToolCalls,
  isSkillLoaded,
} from '../skills/activation'

export interface RuntimeToolDescriptorExecutionInput {
  context: AgentGraphContext
  sessionId: string
  toolCalls: ToolCall[]
  loadedSkills: LoadedAgentSkill[]
}

export interface RuntimeToolDescriptorExecutionResult {
  toolMessages: ToolMessage[]
  memoryOperations?: ChatMemoryOperationProjection[]
  loadedSkills?: LoadedAgentSkill[]
}

export interface RuntimeToolDescriptor {
  name: string
  tool: StructuredToolInterface
  ownerSkillKey?: string
  connectorType?: AgentSkillConnectorType
  executeBeforeSkillActions?: boolean
  refreshRegistryAfterExecution?: boolean
  execute: (input: RuntimeToolDescriptorExecutionInput) => Promise<RuntimeToolDescriptorExecutionResult>
}

export interface RuntimeSkillActionMetadata {
  skillKey?: string
  connectorType?: AgentSkillConnectorType
}

export interface RuntimeToolRegistry {
  tools: StructuredToolInterface[]
  descriptors: RuntimeToolDescriptor[]
  getDescriptor: (actionName: string) => RuntimeToolDescriptor | undefined
  hasVisibleTool: (actionName: string) => boolean
}

export function createRuntimeToolRegistry(input: {
  context: AgentGraphContext | undefined
  memoryApi?: AgentMemoryApiClient
  skillApi?: AgentSkillApiClient
  webSearch?: WebSearchClient
  skillActionProviders?: readonly RuntimeSkillActionProvider[]
  loadedSkills: LoadedAgentSkill[]
}): RuntimeToolRegistry {
  const descriptors: RuntimeToolDescriptor[] = []
  const providerServices = createRuntimeSkillActionProviderServices(input)
  const skillActionProviders = input.skillActionProviders ?? DEFAULT_RUNTIME_SKILL_ACTION_PROVIDERS
  const hasSkillRuntime = Boolean(input.skillApi)

  if (hasRuntimeSkillCatalog(input) && input.skillApi) {
    descriptors.push(...createAgentSkillTools().map(tool => ({
      name: tool.name,
      tool,
      connectorType: AGENT_SKILL_CONNECTOR_TYPE.BUILTIN,
      executeBeforeSkillActions: true,
      refreshRegistryAfterExecution: true,
      async execute(executeInput: RuntimeToolDescriptorExecutionInput) {
        const result = await executeAgentSkillToolCalls({
          skillApi: input.skillApi!,
          context: executeInput.context,
          toolCalls: executeInput.toolCalls,
          loadedSkills: executeInput.loadedSkills,
        })

        return {
          toolMessages: result.toolMessages,
          loadedSkills: result.loadedSkills,
        }
      },
    })))
  }

  for (const provider of skillActionProviders) {
    const needsActivation = requiresRuntimeSkillActivation(input.context, provider.key, hasSkillRuntime)
    if (needsActivation && !isSkillLoaded(input.loadedSkills, provider.key)) {
      continue
    }

    if (!provider.isAvailable({ context: input.context, services: providerServices })) {
      continue
    }

    descriptors.push(...provider.createTools({
      context: input.context,
      services: providerServices,
    }).map(tool => ({
      name: tool.name,
      tool,
      ownerSkillKey: provider.key,
      connectorType: getSkillConnectorType(input.context, provider.key) ?? AGENT_SKILL_CONNECTOR_TYPE.BUILTIN,
      async execute(executeInput: RuntimeToolDescriptorExecutionInput) {
        return provider.executeActions({
          context: executeInput.context,
          services: providerServices,
          sessionId: executeInput.sessionId,
          toolCalls: executeInput.toolCalls,
        })
      },
    })))
  }

  const tools = descriptors.map(descriptor => descriptor.tool)
  const descriptorByName = new Map(descriptors.map(descriptor => [descriptor.name, descriptor]))
  const visibleToolNames = new Set(descriptors.map(descriptor => descriptor.name))
  return {
    descriptors,
    tools,
    getDescriptor: actionName => descriptorByName.get(actionName),
    hasVisibleTool: actionName => visibleToolNames.has(actionName),
  }
}

export function createRuntimeSkillActionProviderServices(input: {
  memoryApi?: AgentMemoryApiClient
  webSearch?: WebSearchClient
}): RuntimeSkillActionProviderServices {
  return {
    memoryApi: input.memoryApi,
    webSearch: input.webSearch,
  }
}

export function listRuntimeSkillActionNames(
  providers: readonly RuntimeSkillActionProvider[] = DEFAULT_RUNTIME_SKILL_ACTION_PROVIDERS,
): readonly string[] {
  return providers.flatMap(provider => provider.actionNames)
}

function hasRuntimeSkillCatalog(input: {
  context: AgentGraphContext | undefined
  skillApi?: AgentSkillApiClient
}): boolean {
  return Boolean(
    input.skillApi
    && input.context?.skillContext
    && input.context.skillContext.availableSkills.some(skill =>
      skill.activationMode !== AGENT_SKILL_ACTIVATION_MODE.MANUAL,
    ),
  )
}

function requiresRuntimeSkillActivation(
  context: AgentGraphContext | undefined,
  skillKey: string,
  hasSkillRuntime: boolean,
): boolean {
  if (!hasSkillRuntime) {
    return false
  }

  const catalogItem = context?.skillContext?.availableSkills.find(skill => skill.key === skillKey)
  return catalogItem?.activationMode !== AGENT_SKILL_ACTIVATION_MODE.ALWAYS_ON
}

function getSkillConnectorType(
  context: AgentGraphContext | undefined,
  skillKey: string,
): AgentSkillConnectorType | undefined {
  return context?.skillContext?.availableSkills.find(skill => skill.key === skillKey)?.connectorType
}
