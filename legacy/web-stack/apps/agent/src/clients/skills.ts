import type {
  ActivateAgentSkillRequest,
  ActivateAgentSkillResponse,
} from '@haohaoxue/lexora-contracts'
import { ActivateAgentSkillResponseSchema } from '@haohaoxue/lexora-contracts'
import { normalizeApiInternalBaseUrl, postApiInternalJson } from './utils'

export interface AgentSkillApiClient {
  activateSkill: (payload: ActivateAgentSkillRequest) => Promise<ActivateAgentSkillResponse>
}

export interface CreateAgentSkillApiClientInput {
  apiInternalUrl: string
  appInternalKey: string
}

export function createAgentSkillApiClient(input: CreateAgentSkillApiClientInput): AgentSkillApiClient {
  const baseUrl = normalizeApiInternalBaseUrl(input.apiInternalUrl)

  return {
    async activateSkill(payload) {
      return ActivateAgentSkillResponseSchema.parse(await postApiInternalJson({
        baseUrl,
        path: 'internal/agent/skills/activate',
        payload,
        errorMessage: '激活技能失败',
        appInternalKey: input.appInternalKey,
      }))
    },
  }
}
