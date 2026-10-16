import type { RuntimeSkillActionProvider } from '../../types'
import {
  AGENT_LOCATION_SKILL_KEY,
  AGENT_LOCATION_TOOL_VALUES,
} from '@haohaoxue/lexora-contracts'
import { executeLocationToolCalls } from './executor'
import {
  createLocationSkillTools,
  isLocationSkillActive,
} from './tools'

export function createLocationSkillActionProvider(): RuntimeSkillActionProvider {
  return {
    key: AGENT_LOCATION_SKILL_KEY,
    actionNames: AGENT_LOCATION_TOOL_VALUES,
    isAvailable({ context }) {
      return isLocationSkillActive(context)
    },
    createTools() {
      return createLocationSkillTools()
    },
    async executeActions(input) {
      return executeLocationToolCalls({
        context: input.context,
        toolCalls: input.toolCalls,
      })
    },
  }
}
