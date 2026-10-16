import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { AgentChatApiClient } from '../clients/chat'
import type { AgentMemoryApiClient } from '../clients/memory'
import type { AgentSkillApiClient } from '../clients/skills'
import type { AgentChatModelFactory } from '../integrations/model-providers/chat-model'
import type { WebSearchClient } from '../integrations/web-search'
import type { RuntimeSkillActionProvider } from './skills/action-providers'
import { END, START, StateGraph } from '@langchain/langgraph'
import {
  createCallModelNode,
  createCompactHistoryNode,
  createPrepareContextNode,
  createRetrieveMemoryNode,
} from './nodes'
import { AgentGraphState } from './state'

export interface CreateAgentGraphOptions {
  chatApi: AgentChatApiClient
  chatModelFactory: AgentChatModelFactory
  memoryApi?: AgentMemoryApiClient
  skillApi?: AgentSkillApiClient
  webSearch?: WebSearchClient
  skillActionProviders?: readonly RuntimeSkillActionProvider[]
  checkpointer?: BaseCheckpointSaver
}

export function createAgentGraph(options: CreateAgentGraphOptions) {
  return new StateGraph(AgentGraphState)
    .addNode('retrieveMemory', createRetrieveMemoryNode({
      memoryApi: options.memoryApi,
    }))
    .addNode('prepareContext', createPrepareContextNode())
    .addNode('compactHistory', createCompactHistoryNode())
    .addNode('callModel', createCallModelNode({
      chatApi: options.chatApi,
      chatModelFactory: options.chatModelFactory,
      memoryApi: options.memoryApi,
      skillApi: options.skillApi,
      webSearch: options.webSearch,
      skillActionProviders: options.skillActionProviders,
    }))
    .addEdge(START, 'retrieveMemory')
    .addEdge('retrieveMemory', 'prepareContext')
    .addEdge('prepareContext', 'compactHistory')
    .addEdge('compactHistory', 'callModel')
    .addEdge('callModel', END)
    .compile({
      name: 'lexora.agent.core',
      checkpointer: options.checkpointer,
    })
}
