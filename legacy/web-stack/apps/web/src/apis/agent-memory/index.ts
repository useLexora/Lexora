import type {
  AgentMemoryDocument,
  AgentMemoryDocumentId,
  AgentMemoryDocumentsResponse,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export interface AgentMemoryDocumentOptions {
  agentProfileId?: string | null
}

export function getAgentMemoryDocuments(options: AgentMemoryDocumentOptions = {}): Promise<AgentMemoryDocumentsResponse> {
  return axios.request({
    method: 'get',
    url: '/users/me/agent/memory-documents',
    params: createAgentMemoryDocumentParams(options),
  })
}

export function getAgentMemoryDocument(documentId: AgentMemoryDocumentId, options: AgentMemoryDocumentOptions = {}): Promise<AgentMemoryDocument> {
  return axios.request({
    method: 'get',
    url: `/users/me/agent/memory-documents/${documentId}`,
    params: createAgentMemoryDocumentParams(options),
  })
}

function createAgentMemoryDocumentParams(options: AgentMemoryDocumentOptions) {
  return options.agentProfileId
    ? { agentProfileId: options.agentProfileId }
    : undefined
}
