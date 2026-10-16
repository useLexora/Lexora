import type { AgentGraphContext } from '../../state'

export function isRuntimeSkillActive(
  context: AgentGraphContext | undefined,
  skillKey: string,
): boolean {
  const config = context?.agentProfileConfig
  if (!config?.toolPolicy.enabled) {
    return false
  }

  const disabledSkillKeys = context?.disabledSkillKeys ?? []
  if (disabledSkillKeys.includes(skillKey)) {
    return false
  }

  const skillContext = context?.skillContext
  if (skillContext) {
    return skillContext.availableSkills.some(skill => skill.key === skillKey)
  }

  return config.skillBindings.some(binding =>
    binding.key === skillKey && binding.enabled,
  )
}
