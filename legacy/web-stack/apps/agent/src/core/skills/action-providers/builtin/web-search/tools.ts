import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_WEB_SEARCH_SKILL_KEY,
  AGENT_WEB_SEARCH_TOOL,
  AgentWebSearchSkillConfigSchema,
} from '@haohaoxue/lexora-contracts'
import { tool } from '@langchain/core/tools'
import { isRuntimeSkillActive } from '../../../activation'
import { WebSearchToolInputSchema } from './schemas'

export function isWebSearchSkillActive(context: AgentGraphContext | undefined): boolean {
  return isRuntimeSkillActive(context, AGENT_WEB_SEARCH_SKILL_KEY)
}

export function createWebSearchSkillTools(): StructuredToolInterface[] {
  return [
    tool(async () => 'web search request received', {
      name: AGENT_WEB_SEARCH_TOOL.SEARCH,
      description: [
        'Search the public web for current or externally verifiable information.',
        'Use for latest facts, recent events, source verification, product/vendor changes, or questions that require URLs.',
        'If the task contains relative dates or times such as today, tomorrow, this week, or latest, call get_current_time first and use its date anchors when forming the query.',
        'For weather, nearby places, local news, routing, stores, or regional policy, call get_current_location first unless the user explicitly provided a location.',
        'If get_current_location returns needs_location, ask for location before searching.',
        'Do not infer search location from time zone, language, locale, IP, provider region, or server defaults.',
        'Do not use for private Lexora documents, local files, or stable reasoning that does not need external sources.',
      ].join(' '),
      schema: WebSearchToolInputSchema,
    }),
  ]
}

export function resolveWebSearchSkillConfig(context: AgentGraphContext) {
  const binding = context.agentProfileConfig?.skillBindings.find(item => item.key === AGENT_WEB_SEARCH_SKILL_KEY)
  return AgentWebSearchSkillConfigSchema.parse(binding?.config ?? {})
}
