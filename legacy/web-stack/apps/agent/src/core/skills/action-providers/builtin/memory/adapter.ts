import type { RuntimeSkillActionProvider } from '../../types'
import {
  AGENT_MEMORY_SKILL_KEY,
  AGENT_MEMORY_TOOL_VALUES,
} from '@haohaoxue/lexora-contracts'
import {
  executeMemoryToolCalls,
} from './executor'
import {
  createMemorySkillTools,
  isMemorySkillActive,
} from './tools'

export function createMemorySkillActionProvider(): RuntimeSkillActionProvider {
  return {
    key: AGENT_MEMORY_SKILL_KEY,
    actionNames: AGENT_MEMORY_TOOL_VALUES,
    isAvailable({ context, services }) {
      return Boolean(services.memoryApi && isMemorySkillActive(context))
    },
    createTools() {
      return createMemorySkillTools()
    },
    async executeActions(input) {
      if (!input.services.memoryApi) {
        return {
          toolMessages: [],
          memoryOperations: [],
        }
      }

      const result = await executeMemoryToolCalls({
        memoryApi: input.services.memoryApi,
        context: input.context,
        sessionId: input.sessionId,
        toolCalls: input.toolCalls,
      })

      return {
        toolMessages: result.toolMessages,
        memoryOperations: result.operations,
      }
    },
  }
}
