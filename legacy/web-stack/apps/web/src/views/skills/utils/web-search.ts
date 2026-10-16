import type {
  AgentWebSearchContextSize,
  AgentWebSearchProvider,
  AgentWebSearchSkillConfig,
} from '@haohaoxue/lexora-contracts/agent'
import {
  AGENT_WEB_SEARCH_CONTEXT_SIZE,
  AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG,
  AGENT_WEB_SEARCH_PROVIDER,
  AGENT_WEB_SEARCH_SKILL_KEY,
  AgentWebSearchSkillConfigSchema,
} from '@haohaoxue/lexora-contracts/agent'

export const WEB_SEARCH_SKILL_KEY = AGENT_WEB_SEARCH_SKILL_KEY

type Translate = (key: string) => string

export interface WebSearchConfigFormModel {
  providers: AgentWebSearchProvider[]
  maxResults: number
  searchContextSize: AgentWebSearchContextSize
  allowedDomainsText: string
  blockedDomainsText: string
}

export function createWebSearchProviderOptions(t: Translate): Array<{ label: string, value: AgentWebSearchProvider }> {
  return [
    { label: t('skills.webSearch.providerDuckDuckGo'), value: AGENT_WEB_SEARCH_PROVIDER.DUCKDUCKGO },
    { label: t('skills.webSearch.providerBing'), value: AGENT_WEB_SEARCH_PROVIDER.BING },
    { label: t('skills.webSearch.providerBaidu'), value: AGENT_WEB_SEARCH_PROVIDER.BAIDU },
  ]
}

export function createWebSearchContextSizeOptions(t: Translate): Array<{ label: string, value: AgentWebSearchContextSize }> {
  return [
    { label: t('skills.webSearch.contextLow'), value: AGENT_WEB_SEARCH_CONTEXT_SIZE.LOW },
    { label: t('skills.webSearch.contextMedium'), value: AGENT_WEB_SEARCH_CONTEXT_SIZE.MEDIUM },
    { label: t('skills.webSearch.contextHigh'), value: AGENT_WEB_SEARCH_CONTEXT_SIZE.HIGH },
  ]
}

export function parseWebSearchSkillConfig(config: unknown): AgentWebSearchSkillConfig {
  return AgentWebSearchSkillConfigSchema.parse(config ?? AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG)
}

export function createWebSearchConfigFormModel(config: unknown): WebSearchConfigFormModel {
  const parsed = parseWebSearchSkillConfig(config)

  return {
    providers: [...parsed.providers],
    maxResults: parsed.maxResults,
    searchContextSize: parsed.searchContextSize,
    allowedDomainsText: parsed.allowedDomains.join('\n'),
    blockedDomainsText: parsed.blockedDomains.join('\n'),
  }
}

export function toWebSearchSkillConfig(model: WebSearchConfigFormModel): AgentWebSearchSkillConfig {
  return AgentWebSearchSkillConfigSchema.parse({
    providers: model.providers,
    maxResults: model.maxResults,
    searchContextSize: model.searchContextSize,
    allowedDomains: parseWebSearchDomainText(model.allowedDomainsText),
    blockedDomains: parseWebSearchDomainText(model.blockedDomainsText),
  })
}

export function parseWebSearchDomainText(value: string): string[] {
  return [...new Set(value
    .split(/[\s,，]+/)
    .map(item => item.trim())
    .filter(Boolean))]
}

export function isWebSearchDomainTextValid(value: string): boolean {
  return AgentWebSearchSkillConfigSchema.safeParse({
    ...AGENT_WEB_SEARCH_DEFAULT_SKILL_CONFIG,
    allowedDomains: parseWebSearchDomainText(value),
  }).success
}
