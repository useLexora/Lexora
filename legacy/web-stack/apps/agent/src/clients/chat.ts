import type {
  AgentChatAttachmentContent,
  ChatGenerationBootstrap,
} from '@haohaoxue/lexora-contracts'
import {
  AgentChatAttachmentContentSchema,
  ChatGenerationBootstrapSchema,
} from '@haohaoxue/lexora-contracts'
import { normalizeApiInternalBaseUrl, postApiInternalJson } from './utils'

export interface AgentChatApiClient {
  getGenerationBootstrap: (options: AgentGetGenerationBootstrapOptions) => Promise<ChatGenerationBootstrap>
  getGenerationAssetContent: (options: AgentGetGenerationAssetContentOptions) => Promise<AgentChatAttachmentContent>
}

export interface AgentGetGenerationBootstrapOptions {
  generationId: string
}

export interface AgentGetGenerationAssetContentOptions {
  generationId: string
  assetId: string
}

export interface CreateAgentChatApiClientInput {
  apiInternalUrl: string
  appInternalKey: string
}

export function createAgentChatApiClient(input: CreateAgentChatApiClientInput): AgentChatApiClient {
  const baseUrl = normalizeApiInternalBaseUrl(input.apiInternalUrl)

  return {
    async getGenerationBootstrap(options) {
      return ChatGenerationBootstrapSchema.parse(await postApiInternalJson({
        baseUrl,
        path: `internal/chat/generations/${encodeURIComponent(options.generationId)}/bootstrap`,
        payload: {},
        errorMessage: '读取聊天生成上下文失败',
        appInternalKey: input.appInternalKey,
      }))
    },

    async getGenerationAssetContent(options) {
      return AgentChatAttachmentContentSchema.parse(await postApiInternalJson({
        baseUrl,
        path: `internal/chat/generations/${encodeURIComponent(options.generationId)}/assets/${encodeURIComponent(options.assetId)}/content`,
        payload: {},
        errorMessage: '读取聊天附件内容失败',
        appInternalKey: input.appInternalKey,
      }))
    },
  }
}
