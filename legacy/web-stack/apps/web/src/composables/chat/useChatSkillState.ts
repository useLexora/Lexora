import type { AgentSkillCard } from '@/apis/agent-skills'
import {
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
  AGENT_TRANSLATOR_SKILL_KEY,
  AGENT_WEB_SEARCH_SKILL_KEY,
} from '@haohaoxue/lexora-contracts/agent'
import { createSharedComposable } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import {
  disableAgentSkill,
  enableAgentSkill,
  getAgentSkills,
} from '@/apis/agent-skills'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export const useChatSkillState = createSharedComposable(() => {
  const installedSkills = shallowRef<AgentSkillCard[]>([])
  const isLoadingSkills = shallowRef(false)
  const updatingSkillKeys = shallowRef(new Set<string>())
  const translatorSkill = computed(() =>
    installedSkills.value.find(skill => skill.key === AGENT_TRANSLATOR_SKILL_KEY) ?? null,
  )
  const translatorSkillEnabled = computed(() =>
    Boolean(translatorSkill.value?.enabled),
  )
  const documentAssistantSkill = computed(() =>
    installedSkills.value.find(skill => skill.key === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY) ?? null,
  )
  const documentAssistantSkillEnabled = computed(() =>
    Boolean(documentAssistantSkill.value?.enabled),
  )
  const webSearchSkill = computed(() =>
    installedSkills.value.find(skill => skill.key === AGENT_WEB_SEARCH_SKILL_KEY) ?? null,
  )
  const webSearchSkillEnabled = computed(() =>
    Boolean(webSearchSkill.value?.enabled),
  )

  async function loadSkills(options: { silent?: boolean } = {}) {
    if (isLoadingSkills.value) {
      return
    }

    isLoadingSkills.value = true
    try {
      const response = await getAgentSkills()
      installedSkills.value = response.mySkills.filter(skill => skill.installed)
    }
    catch (error) {
      if (!options.silent) {
        ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.loadSkills')))
      }
    }
    finally {
      isLoadingSkills.value = false
    }
  }

  async function setSkillEnabled(skill: AgentSkillCard, enabled: boolean) {
    if (skill.enabled === enabled || !canToggleSkill(skill)) {
      return
    }

    setSkillUpdating(skill.key, true)
    try {
      const response = enabled
        ? await enableAgentSkill(skill.key)
        : await disableAgentSkill(skill.key)
      replaceSkill(response.skill)
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(
        error,
        enabled ? translate('chat.errors.enableSkill') : translate('chat.errors.disableSkill'),
      ))
    }
    finally {
      setSkillUpdating(skill.key, false)
    }
  }

  function canToggleSkill(skill: AgentSkillCard) {
    return skill.enabled ? skill.canDisable : skill.canEnable
  }

  function isSkillUpdating(skillKey: string) {
    return updatingSkillKeys.value.has(skillKey)
  }

  function replaceSkill(nextSkill: AgentSkillCard) {
    installedSkills.value = installedSkills.value.map(skill =>
      skill.key === nextSkill.key ? nextSkill : skill,
    )
  }

  function setSkillUpdating(skillKey: string, updating: boolean) {
    const nextKeys = new Set(updatingSkillKeys.value)
    if (updating) {
      nextKeys.add(skillKey)
    }
    else {
      nextKeys.delete(skillKey)
    }
    updatingSkillKeys.value = nextKeys
  }

  return {
    canToggleSkill,
    installedSkills,
    isLoadingSkills,
    isSkillUpdating,
    loadSkills,
    setSkillEnabled,
    documentAssistantSkillEnabled,
    translatorSkillEnabled,
    webSearchSkillEnabled,
  }
})
