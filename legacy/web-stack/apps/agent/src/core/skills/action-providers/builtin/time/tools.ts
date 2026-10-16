import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_TIME_SKILL_KEY,
  AGENT_TIME_TOOL,
} from '@haohaoxue/lexora-contracts'
import { tool } from '@langchain/core/tools'
import { isRuntimeSkillActive } from '../../../activation'
import { GetCurrentTimeToolInputSchema } from './schemas'

export function isTimeSkillActive(context: AgentGraphContext | undefined): boolean {
  return isRuntimeSkillActive(context, AGENT_TIME_SKILL_KEY)
}

export function createTimeSkillTools(): StructuredToolInterface[] {
  return [
    tool(async () => 'current time request received', {
      name: AGENT_TIME_TOOL.GET_CURRENT_TIME,
      description: [
        'Return the current date, current time, IANA time zone, and relative date anchors.',
        'Use this for questions involving today, tomorrow, yesterday, current time, this week, next week, future date anchors, or timezone-sensitive scheduling.',
        'Call this before web search when the search task contains relative dates or times.',
        'If the user explicitly provides an IANA time zone, pass it as timeZone.',
        'This tool does not provide user location. Use get_current_location for location-sensitive tasks and do not infer city, country/region, weather location, or local search location from time zone.',
      ].join(' '),
      schema: GetCurrentTimeToolInputSchema,
    }),
  ]
}
