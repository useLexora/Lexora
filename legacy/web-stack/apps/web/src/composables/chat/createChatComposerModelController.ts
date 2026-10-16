import type { Ref } from 'vue'
import type { ChatApi } from './createChatApi'
import type { ChatSessionDetail } from '@/apis/chat'
import type { ChatComposerModelRef } from '@/components/chat-composer'
import { computed, shallowRef, watch } from 'vue'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { useChatModels } from './useChatModels'
import { useChatRuntimeConfig } from './useChatRuntimeConfig'
import {
  isSameNullableModelRef,
  normalizeNullableModelRef,
  resolveChatRequestModelRef,
} from './utils/chat-model-selection'

export type ChatComposerModelSelectionKind = 'default' | 'draft' | 'override'
type NewSessionModelDraftSource = 'default' | 'draft'

export interface ChatComposerModelSessions {
  activeSession: Ref<ChatSessionDetail | null>
  replaceActiveSession: (session: ChatSessionDetail) => boolean
}

export type ChatComposerModelController = ReturnType<typeof createChatComposerModelController>

export function createChatComposerModelController(
  sessions: ChatComposerModelSessions,
  api: ChatApi,
) {
  const { loadRuntimeConfig, runtimeConfig } = useChatRuntimeConfig()
  const { modelOptions, refreshModels } = useChatModels()
  const newSessionModelDraft = shallowRef<ChatComposerModelRef | null>(null)
  const newSessionModelDraftSource = shallowRef<NewSessionModelDraftSource | null>(null)

  const sessionModelRef = computed(() => sessions.activeSession.value?.modelRef ?? null)
  const defaultModelRef = computed(() => resolveChatRequestModelRef(
    null,
    modelOptions.value,
    runtimeConfig.value.defaultModel,
  ))
  const sessionRequestModelRef = computed(() => resolveChatRequestModelRef(
    sessionModelRef.value,
    modelOptions.value,
    null,
  ))
  const requestModelRef = computed(() => sessions.activeSession.value
    ? sessionRequestModelRef.value ?? defaultModelRef.value
    : newSessionModelDraft.value)
  const composerSelectedModelRef = computed(() => requestModelRef.value)
  const composerSelectedModel = computed(() => {
    const modelRef = composerSelectedModelRef.value
    if (!modelRef) {
      return null
    }

    const matchedModel = modelOptions.value.find(model =>
      model.providerId === modelRef.providerId && model.modelId === modelRef.modelId,
    )
    if (matchedModel) {
      return matchedModel
    }

    const defaultModel = runtimeConfig.value.defaultModel
    return defaultModel?.providerId === modelRef.providerId && defaultModel.modelId === modelRef.modelId
      ? defaultModel
      : null
  })
  const composerModelSelectionKind = computed<ChatComposerModelSelectionKind>(() => {
    if (sessions.activeSession.value) {
      return sessionModelRef.value ? 'override' : 'default'
    }

    return newSessionModelDraftSource.value === 'draft' ? 'draft' : 'default'
  })
  const shouldPersistComposerModelRef = computed(() => {
    if (sessions.activeSession.value) {
      return Boolean(sessionModelRef.value)
    }

    return Boolean(newSessionModelDraft.value)
  })
  const isConfigured = computed(() => Boolean(composerSelectedModelRef.value))

  watch(
    () => [
      sessions.activeSession.value?.id ?? null,
      defaultModelRef.value,
      newSessionModelDraftSource.value,
    ] as const,
    ([activeSessionId, defaultModel, draftSource]) => {
      if (activeSessionId || draftSource || !defaultModel) {
        return
      }

      newSessionModelDraft.value = defaultModel
      newSessionModelDraftSource.value = 'default'
    },
    { immediate: true },
  )

  async function loadModelState() {
    if (await loadRuntimeConfig()) {
      await refreshModels({
        silent: true,
        showSuccessMessage: false,
        skipRuntimeConfigReload: true,
      })
    }
  }

  async function selectComposerModel(modelRef: ChatComposerModelRef | null) {
    const nextModelRef = normalizeNullableModelRef(modelRef)
    const activeSession = sessions.activeSession.value

    if (!activeSession) {
      newSessionModelDraft.value = nextModelRef
      newSessionModelDraftSource.value = 'draft'
      return true
    }

    if (isSameNullableModelRef(nextModelRef, activeSession.modelRef)) {
      return true
    }

    try {
      const updatedSession = await api.updateSessionModel(activeSession.id, {
        modelRef: nextModelRef,
      })
      sessions.replaceActiveSession(updatedSession)
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.switchModel')))
      return false
    }
  }

  function clearNewSessionModelDraft() {
    newSessionModelDraft.value = null
    newSessionModelDraftSource.value = null
  }

  return {
    clearNewSessionModelDraft,
    composerModelSelectionKind,
    composerSelectedModel,
    composerSelectedModelRef,
    isConfigured,
    loadModelState,
    requestModelRef,
    selectComposerModel,
    shouldPersistComposerModelRef,
  }
}
