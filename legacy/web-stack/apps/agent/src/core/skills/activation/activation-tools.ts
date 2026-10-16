import type { StructuredToolInterface } from '@langchain/core/tools'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { AGENT_SKILL_TOOL_NAME } from './tool-names'

export const ActivateSkillToolSchema = z.object({
  skillKey: z.string().trim().min(1).describe('Exact skill key from the available_skills catalog.'),
}).strict()

export function createAgentSkillTools(): StructuredToolInterface[] {
  return [
    tool(async () => 'skill activation requested', {
      name: AGENT_SKILL_TOOL_NAME.ACTIVATE,
      description: 'Load the full instructions for a named Lexora Agent Skill before following that skill workflow.',
      schema: ActivateSkillToolSchema,
    }),
  ]
}
