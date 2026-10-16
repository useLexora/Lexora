import type { RuntimeSkillActionProvider } from '../../types'
import {
  AGENT_WEB_SEARCH_SKILL_KEY,
  AGENT_WEB_SEARCH_TOOL_VALUES,
} from '@haohaoxue/lexora-contracts'
import { executeWebSearchToolCalls } from './executor'
import {
  createWebSearchSkillTools,
  isWebSearchSkillActive,
} from './tools'

export function createWebSearchSkillActionProvider(): RuntimeSkillActionProvider {
  return {
    key: AGENT_WEB_SEARCH_SKILL_KEY,
    actionNames: AGENT_WEB_SEARCH_TOOL_VALUES,
    isAvailable({ context, services }) {
      return Boolean(services.webSearch && isWebSearchSkillActive(context))
    },
    createTools() {
      return createWebSearchSkillTools()
    },
    async executeActions(input) {
      if (!input.services.webSearch) {
        return {
          toolMessages: [],
        }
      }

      return executeWebSearchToolCalls({
        context: input.context,
        webSearch: input.services.webSearch,
        toolCalls: input.toolCalls,
      })
    },
  }
}
