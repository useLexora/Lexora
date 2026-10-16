import type {
  AgentAmapMcpSkillCardConfig,
  AgentAmapMcpSkillCredentialConfig,
} from '@haohaoxue/lexora-contracts/agent'
import {
  AGENT_AMAP_MCP_SKILL_KEY,
  AgentAmapMcpSkillCardConfigSchema,
  AgentAmapMcpSkillCredentialConfigSchema,
} from '@haohaoxue/lexora-contracts/agent'

export const AMAP_MCP_SKILL_KEY = AGENT_AMAP_MCP_SKILL_KEY

export interface AmapMcpConfigFormModel {
  apiKey: string
  apiKeyConfigured: boolean
}

export function parseAmapMcpSkillCardConfig(config: unknown): AgentAmapMcpSkillCardConfig {
  const result = AgentAmapMcpSkillCardConfigSchema.safeParse(config ?? {})

  return result.success ? result.data : AgentAmapMcpSkillCardConfigSchema.parse({})
}

export function createAmapMcpConfigFormModel(config: unknown): AmapMcpConfigFormModel {
  const parsed = parseAmapMcpSkillCardConfig(config)

  return {
    apiKey: '',
    apiKeyConfigured: parsed.apiKeyConfigured,
  }
}

export function toAmapMcpSkillConfig(model: AmapMcpConfigFormModel): AgentAmapMcpSkillCredentialConfig {
  const apiKey = model.apiKey.trim()
  return AgentAmapMcpSkillCredentialConfigSchema.parse(apiKey ? { apiKey } : {})
}
