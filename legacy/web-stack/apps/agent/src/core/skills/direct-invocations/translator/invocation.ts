import type {
  AgentChatContextMessage,
  AgentProfileConfig,
  AgentRuntimeSkillContext,
  AgentTranslatorSkillConfig,
  AgentTranslatorTargetLanguage,
} from '@haohaoxue/lexora-contracts'
import {
  AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG,
  AGENT_TRANSLATOR_SKILL_KEY,
  AgentTranslatorSkillConfigSchema,
} from '@haohaoxue/lexora-contracts'

export interface DirectTranslatorInvocation {
  skillKey: typeof AGENT_TRANSLATOR_SKILL_KEY
  targetLanguage: AgentTranslatorTargetLanguage
  config: AgentTranslatorSkillConfig
}

export function resolveDirectTranslatorInvocation(input: {
  messages: AgentChatContextMessage[]
  triggerUserMessageId: string | null | undefined
  agentProfileConfig?: AgentProfileConfig | null
  skillContext?: AgentRuntimeSkillContext | null
}): DirectTranslatorInvocation | null {
  if (!input.triggerUserMessageId) {
    return null
  }

  const triggerMessage = input.messages.find(message =>
    message.id === input.triggerUserMessageId && message.role === 'user',
  )
  const skillInvocation = triggerMessage?.skillInvocation

  if (skillInvocation?.skillKey !== AGENT_TRANSLATOR_SKILL_KEY) {
    return null
  }

  if (!isTranslatorAvailable(input.skillContext)) {
    return null
  }

  return {
    skillKey: skillInvocation.skillKey,
    targetLanguage: skillInvocation.targetLanguage,
    config: resolveTranslatorSkillConfig(input.agentProfileConfig),
  }
}

function resolveTranslatorSkillConfig(agentProfileConfig: AgentProfileConfig | null | undefined): AgentTranslatorSkillConfig {
  const binding = agentProfileConfig?.skillBindings.find(item => item.key === AGENT_TRANSLATOR_SKILL_KEY)
  const parsed = AgentTranslatorSkillConfigSchema.safeParse(binding?.config ?? AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG)
  return parsed.success ? parsed.data : AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG
}

function isTranslatorAvailable(skillContext: AgentRuntimeSkillContext | null | undefined): boolean {
  return Boolean(skillContext?.availableSkills.some(skill => skill.key === AGENT_TRANSLATOR_SKILL_KEY))
}
