import type { ChatMemoryOperationProjection } from '@haohaoxue/lexora-contracts'
import type { ToolCall, ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentMemoryApiClient } from '../../../clients/memory'
import type { WebSearchClient } from '../../../integrations/web-search'
import type { AgentGraphContext } from '../../state'

export interface RuntimeSkillActionProviderServices {
  memoryApi?: AgentMemoryApiClient
  webSearch?: WebSearchClient
}

export interface RuntimeSkillActionProvider {
  key: string
  actionNames: readonly string[]
  isAvailable: (input: {
    context: AgentGraphContext | undefined
    services: RuntimeSkillActionProviderServices
  }) => boolean
  createTools: (input: {
    context: AgentGraphContext | undefined
    services: RuntimeSkillActionProviderServices
  }) => StructuredToolInterface[]
  executeActions: (input: {
    context: AgentGraphContext
    services: RuntimeSkillActionProviderServices
    sessionId: string
    toolCalls: ToolCall[]
  }) => Promise<{
    toolMessages: ToolMessage[]
    memoryOperations?: ChatMemoryOperationProjection[]
  }>
}
