import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_MEMORY_SKILL_KEY,
  AGENT_MEMORY_SLOT_KEY,
  AGENT_MEMORY_TOOL,
} from '@haohaoxue/lexora-contracts'
import { tool } from '@langchain/core/tools'
import { isRuntimeSkillActive } from '../../../activation'
import {
  MemoryForgetSchema,
  MemoryUpdateSchema,
  MemoryWriteBaseSchema,
} from './schemas'

export function isMemorySkillActive(context: AgentGraphContext | undefined): boolean {
  const config = context?.agentProfileConfig
  if (!config || config.memoryPolicy.writing.enabled === false) {
    return false
  }

  return isRuntimeSkillActive(context, AGENT_MEMORY_SKILL_KEY)
}

export function createMemorySkillTools(): StructuredToolInterface[] {
  return [
    tool(async () => 'memory proposal received', {
      name: AGENT_MEMORY_TOOL.REMEMBER,
      description: [
        'Save a durable user memory. Use semantic judgment across languages; do not rely on exact keywords.',
        'Use for long-lived preferences, profile facts, stable feedback, project references, task knowledge, or agent personalization.',
        'Do not use for short-lived task state, secrets, credentials, or unsupported guesses.',
      ].join(' '),
      schema: MemoryWriteBaseSchema,
    }),
    tool(async () => 'memory update proposal received', {
      name: AGENT_MEMORY_TOOL.UPDATE,
      description: [
        'Update or correct an existing memory or stable slot.',
        `Use relatedMemoryIds from provided memory context, or use slotKey for stable facts such as ${AGENT_MEMORY_SLOT_KEY.AGENT_NAME}.`,
        `When the user gives the agent a name, nickname, or asks to call you by a name, use scope=user_agent, lane=agent_personalization, slotKey=${AGENT_MEMORY_SLOT_KEY.AGENT_NAME}, and slotValue set to that name.`,
        'Do not invent unrelated memory ids.',
      ].join(' '),
      schema: MemoryUpdateSchema,
    }),
    tool(async () => 'memory forget proposal received', {
      name: AGENT_MEMORY_TOOL.FORGET,
      description: [
        'Forget or archive a memory when the user asks to forget, delete, remove, or correct obsolete remembered information.',
        'This works in any language. Provide a semantic query and relatedMemoryIds when known.',
      ].join(' '),
      schema: MemoryForgetSchema,
    }),
  ]
}
