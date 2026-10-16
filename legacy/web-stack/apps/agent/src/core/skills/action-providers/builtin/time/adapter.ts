import type { RuntimeSkillActionProvider } from '../../types'
import {
  AGENT_TIME_SKILL_KEY,
  AGENT_TIME_TOOL_VALUES,
} from '@haohaoxue/lexora-contracts'
import { executeTimeToolCalls } from './executor'
import {
  createTimeSkillTools,
  isTimeSkillActive,
} from './tools'

export function createTimeSkillActionProvider(): RuntimeSkillActionProvider {
  return {
    key: AGENT_TIME_SKILL_KEY,
    actionNames: AGENT_TIME_TOOL_VALUES,
    isAvailable({ context }) {
      return isTimeSkillActive(context)
    },
    createTools() {
      return createTimeSkillTools()
    },
    async executeActions(input) {
      return executeTimeToolCalls({
        context: input.context,
        toolCalls: input.toolCalls,
      })
    },
  }
}
