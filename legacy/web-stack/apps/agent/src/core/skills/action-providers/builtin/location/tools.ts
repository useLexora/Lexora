import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_LOCATION_SKILL_KEY,
  AGENT_LOCATION_TOOL,
} from '@haohaoxue/lexora-contracts'
import { tool } from '@langchain/core/tools'
import { isRuntimeSkillActive } from '../../../activation'
import { GetCurrentLocationToolInputSchema } from './schemas'

export function isLocationSkillActive(context: AgentGraphContext | undefined): boolean {
  return isRuntimeSkillActive(context, AGENT_LOCATION_SKILL_KEY)
}

export function createLocationSkillTools(): StructuredToolInterface[] {
  return [
    tool(async () => 'current location request received', {
      name: AGENT_LOCATION_TOOL.GET_CURRENT_LOCATION,
      description: [
        'Return the current user location resolved by the Location Skill.',
        'Use this for weather, nearby places, local news, regional policy, routing, stores, and other location-sensitive tasks.',
        'If this returns ok, use the returned location. If this returns needs_location, ask the user for the relevant city or place before web search.',
      ].join(' '),
      schema: GetCurrentLocationToolInputSchema,
    }),
  ]
}
