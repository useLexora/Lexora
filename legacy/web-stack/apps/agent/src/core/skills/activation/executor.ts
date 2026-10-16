import type { AgentRuntimeSkillCatalogItem, AgentRuntimeSkillContext } from '@haohaoxue/lexora-contracts'
import type { ToolCall } from '@langchain/core/messages'
import type { AgentSkillApiClient } from '../../../clients/skills'
import type { AgentGraphContext } from '../../state'
import type { LoadedAgentSkill } from './types'
import { AGENT_SKILL_ACTIVATION_MODE } from '@haohaoxue/lexora-contracts'
import { ToolMessage } from '@langchain/core/messages'
import { ActivateSkillToolSchema } from './activation-tools'
import { escapeSkillPromptText } from './escape'
import { AGENT_SKILL_TOOL_NAME } from './tool-names'

export function isSkillLoaded(loadedSkills: LoadedAgentSkill[], skillKey: string): boolean {
  return loadedSkills.some(skill => skill.key === skillKey)
}

export async function executeAgentSkillToolCalls(input: {
  skillApi: AgentSkillApiClient
  context: AgentGraphContext
  toolCalls: ToolCall[]
  loadedSkills: LoadedAgentSkill[]
}): Promise<{
  toolMessages: ToolMessage[]
  loadedSkills: LoadedAgentSkill[]
}> {
  const toolMessages: ToolMessage[] = []
  let loadedSkills = input.loadedSkills.slice()

  for (const toolCall of input.toolCalls) {
    if (!input.context.actorUserId || !input.context.generationId) {
      toolMessages.push(createSkillToolMessage(toolCall, {
        status: 'failed',
        reason: 'Missing skill execution context.',
      }, 'error'))
      continue
    }

    try {
      if (toolCall.name === AGENT_SKILL_TOOL_NAME.ACTIVATE) {
        const args = ActivateSkillToolSchema.parse(toolCall.args)
        const catalogItem = findCatalogItem(input.context.skillContext, args.skillKey)
        if (!catalogItem) {
          toolMessages.push(createSkillToolMessage(toolCall, {
            status: 'failed',
            reason: `Skill is not available in this run: ${args.skillKey}`,
          }, 'error'))
          continue
        }

        if (loadedSkills.some(skill => skill.key === catalogItem.key)) {
          toolMessages.push(createSkillToolMessage(toolCall, {
            status: 'ok',
            reason: `Skill is already activated: ${catalogItem.key}`,
          }))
          continue
        }

        const response = await input.skillApi.activateSkill({
          actorUserId: input.context.actorUserId,
          generationId: input.context.generationId,
          skillKey: catalogItem.key,
        })

        loadedSkills = upsertLoadedSkill(loadedSkills, {
          key: response.skill.key,
        })
        toolMessages.push(new ToolMessage({
          tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
          content: renderActivatedSkill(response.skill),
        }))
        continue
      }
    }
    catch (error) {
      toolMessages.push(createSkillToolMessage(toolCall, {
        status: 'failed',
        reason: formatSkillToolError(error),
      }, 'error'))
    }
  }

  return {
    toolMessages,
    loadedSkills,
  }
}

function renderActivatedSkill(skill: AgentRuntimeSkillCatalogItem & {
  instructions: string
}): string {
  const runtimeActions = skill.actions.length === 0
    ? '- none'
    : [
        'Use the exact action name shown below after this skill is activated. Do not call activate_skill again for this skill unless activation failed.',
        ...skill.actions.map(action => [
          '  <action>',
          `    <name>${escapeSkillPromptText(action.name)}</name>`,
          `    <title>${escapeSkillPromptText(action.title)}</title>`,
          `    <description>${escapeSkillPromptText(action.description)}</description>`,
          '  </action>',
        ].join('\n')),
      ].join('\n')

  return [
    `<skill_content key="${escapeSkillPromptText(skill.key)}">`,
    '<description>',
    skill.description,
    '</description>',
    '',
    '<instructions>',
    skill.instructions,
    '</instructions>',
    '',
    '<runtime_actions>',
    runtimeActions,
    '</runtime_actions>',
    '</skill_content>',
  ].join('\n')
}

function findCatalogItem(
  skillContext: AgentRuntimeSkillContext | null | undefined,
  skillKey: string,
): AgentRuntimeSkillCatalogItem | null {
  const normalized = skillKey.trim().toLowerCase()
  return skillContext?.availableSkills.find(skill =>
    skill.key === normalized
    && skill.activationMode !== AGENT_SKILL_ACTIVATION_MODE.MANUAL,
  ) ?? null
}

function upsertLoadedSkill(loadedSkills: LoadedAgentSkill[], next: LoadedAgentSkill): LoadedAgentSkill[] {
  return [
    ...loadedSkills.filter(skill => skill.key !== next.key),
    next,
  ]
}

function createSkillToolMessage(
  toolCall: ToolCall,
  content: unknown,
  status: 'success' | 'error' = 'success',
): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
    status,
    content: JSON.stringify(content),
  })
}

function formatSkillToolError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Skill tool execution failed.'
}
