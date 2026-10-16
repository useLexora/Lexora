import type {
  AgentDocumentAssistantEditIntent,
  AgentTranslatorTargetLanguage,
} from '@haohaoxue/lexora-contracts/agent'
import type { MaybeRefOrGetter } from 'vue'
import { computed, shallowRef, toValue, watch } from 'vue'
import { useChatSkillState } from './useChatSkillState'

export interface UseChatComposerSkillControlsOptions {
  activeSessionId: MaybeRefOrGetter<string | null | undefined>
}

export function useChatComposerSkillControls(options: UseChatComposerSkillControlsOptions) {
  const {
    documentAssistantSkillEnabled,
    loadSkills,
    translatorSkillEnabled,
    webSearchSkillEnabled,
  } = useChatSkillState()
  const documentAssistantEditIntent = shallowRef<AgentDocumentAssistantEditIntent | null>(null)
  const translatorTargetLanguage = shallowRef<AgentTranslatorTargetLanguage | null>(null)
  const newSessionWebSearchForRunEnabled = shallowRef(true)
  const webSearchForRunEnabledBySessionId = shallowRef(new Map<string, boolean>())
  const activeSessionId = computed(() => toValue(options.activeSessionId) ?? null)
  const webSearchForRunEnabled = computed({
    get() {
      const sessionId = activeSessionId.value
      if (!sessionId) {
        return newSessionWebSearchForRunEnabled.value
      }

      return webSearchForRunEnabledBySessionId.value.get(sessionId) ?? true
    },
    set(enabled: boolean) {
      const sessionId = activeSessionId.value
      if (!sessionId) {
        newSessionWebSearchForRunEnabled.value = enabled
        return
      }

      setSessionWebSearchForRunEnabled(sessionId, enabled)
    },
  })

  watch(translatorSkillEnabled, (enabled) => {
    if (!enabled) {
      clearTranslatorTargetLanguage()
    }
  })

  watch(documentAssistantSkillEnabled, (enabled) => {
    if (!enabled) {
      clearDocumentAssistantEditIntent()
    }
  })

  watch(activeSessionId, (sessionId) => {
    if (!sessionId) {
      resetNewSessionWebSearchForRunEnabled()
    }
  })

  function clearTranslatorTargetLanguage() {
    translatorTargetLanguage.value = null
  }

  function clearDocumentAssistantEditIntent() {
    documentAssistantEditIntent.value = null
  }

  function resetNewSessionWebSearchForRunEnabled() {
    newSessionWebSearchForRunEnabled.value = true
  }

  function setSessionWebSearchForRunEnabled(sessionId: string, enabled: boolean) {
    const nextValues = new Map(webSearchForRunEnabledBySessionId.value)
    if (enabled) {
      nextValues.delete(sessionId)
    }
    else {
      nextValues.set(sessionId, false)
    }
    webSearchForRunEnabledBySessionId.value = nextValues
  }

  return {
    clearDocumentAssistantEditIntent,
    clearTranslatorTargetLanguage,
    documentAssistantEditIntent,
    documentAssistantSkillEnabled,
    loadSkills,
    resetNewSessionWebSearchForRunEnabled,
    setSessionWebSearchForRunEnabled,
    translatorSkillEnabled,
    translatorTargetLanguage,
    webSearchForRunEnabled,
    webSearchSkillEnabled,
  }
}
