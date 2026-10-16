import type {
  ExecuteAgentMemoryOperationProposalsRequest,
  ExecuteAgentMemoryOperationProposalsResponse,
  RetrieveAgentMemoryRequest,
  RetrieveAgentMemoryResponse,
} from '@haohaoxue/lexora-contracts'
import {
  ExecuteAgentMemoryOperationProposalsResponseSchema,
  RetrieveAgentMemoryResponseSchema,
} from '@haohaoxue/lexora-contracts'
import { normalizeApiInternalBaseUrl, postApiInternalJson } from './utils'

export interface AgentMemoryApiClient {
  retrieveMemories: (payload: RetrieveAgentMemoryRequest) => Promise<RetrieveAgentMemoryResponse>
  executeOperationProposals: (
    payload: ExecuteAgentMemoryOperationProposalsRequest,
  ) => Promise<ExecuteAgentMemoryOperationProposalsResponse>
}

export interface CreateAgentMemoryApiClientInput {
  apiInternalUrl: string
  appInternalKey: string
}

export function createAgentMemoryApiClient(input: CreateAgentMemoryApiClientInput): AgentMemoryApiClient {
  const baseUrl = normalizeApiInternalBaseUrl(input.apiInternalUrl)

  return {
    async retrieveMemories(payload) {
      return RetrieveAgentMemoryResponseSchema.parse(await postApiInternalJson({
        baseUrl,
        path: 'internal/agent/memory/retrieve',
        payload,
        errorMessage: '读取长期记忆失败',
        appInternalKey: input.appInternalKey,
      }))
    },

    async executeOperationProposals(payload) {
      return ExecuteAgentMemoryOperationProposalsResponseSchema.parse(await postApiInternalJson({
        baseUrl,
        path: 'internal/agent/memory/operations',
        payload,
        errorMessage: '执行长期记忆工具失败',
        appInternalKey: input.appInternalKey,
      }))
    },
  }
}
