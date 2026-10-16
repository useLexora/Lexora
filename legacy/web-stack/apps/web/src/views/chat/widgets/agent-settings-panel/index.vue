<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type {
  AgentMemoryDocumentView,
  ChatAgentSettingsPanelEmits,
  ChatAgentSettingsPanelProps,
} from './typing'
import type {
  AgentMemoryDocument as AgentMemoryDocumentContract,
  AgentMemoryDocumentId,
} from '@/apis/agent-memory'
import type { AgentProfileSettings } from '@/apis/agent-profile'
import type { AiModelRef } from '@/apis/ai'
import { AI_MODEL_INTENT_KEY } from '@haohaoxue/lexora-contracts/ai/constants'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAgentMemoryDocuments } from '@/apis/agent-memory'
import {
  getDefaultAgentProfileSettings,
  updateDefaultAgentProfileModel,
} from '@/apis/agent-profile'
import { ChatMarkdownContent } from '@/components/chat-markdown'
import Empty from '@/components/empty'
import ModelCascader from '@/components/model-cascader'
import { useChatSkillState } from '@/composables/chat/useChatSkillState'
import { resolveAgentSkillIcon } from '@/utils/agent-skills'
import dayjs from '@/utils/dayjs'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

const props = defineProps<ChatAgentSettingsPanelProps>()
const emits = defineEmits<ChatAgentSettingsPanelEmits>()
const { t } = useI18n({ useScope: 'global' })

type AgentSettingsView = 'overview' | 'skills' | 'memories' | 'document'

const defaultAgentProfileSettings = shallowRef<AgentProfileSettings | null>(null)
const agentProfileId = computed(() => props.agentProfile?.profileId ?? defaultAgentProfileSettings.value?.profileId ?? null)
const agentName = computed(() => resolveAgentProfileValue('name') ?? t('chat.agentSettings.fallbackName'))
const agentDescription = computed(() => resolveAgentProfileValue('description') ?? t('chat.agentSettings.fallbackDescription'))
const agentAvatarUrl = computed(() => resolveAgentProfileValue('avatarUrl') ?? '/ai-assistant-avatar.png')
const {
  canToggleSkill,
  installedSkills,
  isLoadingSkills,
  isSkillUpdating,
  loadSkills: refreshSkills,
  setSkillEnabled,
} = useChatSkillState()
const memoryDocuments = shallowRef<AgentMemoryDocumentView[]>([])
const isMemoryDocumentsLoading = shallowRef(false)
const skillDescriptionTooltipStyle: CSSProperties = {
  maxWidth: '18rem',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  lineHeight: '1.5',
}
const defaultModelRef = shallowRef<Pick<AiModelRef, 'providerId' | 'modelId'> | null>(null)
const isDefaultModelLoading = shallowRef(false)
const isDefaultModelSaving = shallowRef(false)
const currentView = shallowRef<AgentSettingsView>('overview')
const selectedMemoryId = shallowRef<AgentMemoryDocumentId | null>(null)
let memoryDocumentsRequestId = 0
const selectedMemoryDocument = computed(() => memoryDocuments.value.find(document => document.id === selectedMemoryId.value) ?? null)
const hasSelectedMemoryContent = computed(() => Boolean(selectedMemoryDocument.value?.content.trim()))
const panelTitle = computed(() => {
  if (currentView.value === 'document') {
    return selectedMemoryDocument.value
      ? t('chat.agentSettings.memoryDocumentTitle', { name: selectedMemoryDocument.value.name })
      : t('chat.agentSettings.memory')
  }

  if (currentView.value === 'skills') {
    return t('chat.agentSettings.skills')
  }

  if (currentView.value === 'memories') {
    return t('chat.agentSettings.memory')
  }

  return t('chat.agentSettings.title')
})

onMounted(() => {
  void refreshSkills()
  void loadDefaultAgentProfileSettings()
})

watch(agentProfileId, () => {
  selectedMemoryId.value = null
  void loadMemoryDocuments()
}, { immediate: true })

function openMemories() {
  selectedMemoryId.value = null
  currentView.value = 'memories'
  void loadMemoryDocuments()
}

function openSkills() {
  currentView.value = 'skills'
  void refreshSkills()
}

function openMemoryDocument(document: AgentMemoryDocumentView) {
  selectedMemoryId.value = document.id
  currentView.value = 'document'
}

function goBack() {
  if (currentView.value === 'document') {
    currentView.value = 'memories'
    return
  }

  currentView.value = 'overview'
}

async function loadMemoryDocuments() {
  const requestId = ++memoryDocumentsRequestId
  isMemoryDocumentsLoading.value = true
  try {
    const response = await getAgentMemoryDocuments({
      agentProfileId: agentProfileId.value,
    })
    if (requestId !== memoryDocumentsRequestId) {
      return
    }
    memoryDocuments.value = response.documents.map(toMemoryDocumentView)
  }
  catch (error) {
    if (requestId !== memoryDocumentsRequestId) {
      return
    }
    ElMessage.error(getRequestErrorDisplayMessage(error, t('chat.errors.loadMemoryDocuments')))
  }
  finally {
    if (requestId === memoryDocumentsRequestId) {
      isMemoryDocumentsLoading.value = false
    }
  }
}

async function loadDefaultAgentProfileSettings() {
  if (isDefaultModelLoading.value) {
    return
  }

  isDefaultModelLoading.value = true
  try {
    const profile = await getDefaultAgentProfileSettings()
    defaultAgentProfileSettings.value = profile
    defaultModelRef.value = profile.modelRef
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t('chat.errors.loadDefaultModel')))
  }
  finally {
    isDefaultModelLoading.value = false
  }
}

async function handleDefaultModelChange(modelRef: AiModelRef | null) {
  const previousModelRef = defaultModelRef.value
  defaultModelRef.value = modelRef
    ? {
        providerId: modelRef.providerId,
        modelId: modelRef.modelId,
      }
    : null
  isDefaultModelSaving.value = true

  try {
    const profile = await updateDefaultAgentProfileModel({
      modelRef: defaultModelRef.value,
    })
    defaultModelRef.value = profile.modelRef
    emits('defaultModelUpdated')
    ElMessage.success(defaultModelRef.value ? t('chat.agentSettings.defaultModelUpdated') : t('chat.agentSettings.defaultModelCleared'))
  }
  catch (error) {
    defaultModelRef.value = previousModelRef
    ElMessage.error(getRequestErrorDisplayMessage(error, t('chat.errors.updateDefaultModel')))
  }
  finally {
    isDefaultModelSaving.value = false
  }
}

function handleSkillEnabledChange(skillKey: string, enabled: string | number | boolean) {
  const skill = installedSkills.value.find(item => item.key === skillKey)
  if (!skill) {
    return
  }

  void setSkillEnabled(skill, Boolean(enabled))
}

function toMemoryDocumentView(document: AgentMemoryDocumentContract): AgentMemoryDocumentView {
  return {
    id: document.id,
    name: document.name,
    sizeText: formatMemoryDocumentSize(document.sizeBytes),
    updatedAtText: formatMemoryDocumentUpdatedAt(document.updatedAt),
    summary: document.summary,
    content: document.content,
  }
}

function formatMemoryDocumentSize(sizeBytes: number): string {
  return prettyBytes(sizeBytes, { precision: 2 }).replace(/^([\d.]+)([A-Z]+)$/, '$1 $2')
}

function formatMemoryDocumentUpdatedAt(updatedAt: string | null): string {
  return updatedAt ? dayjs(updatedAt).format('YYYY/M/D HH:mm') : t('chat.agentSettings.memoryNotGenerated')
}

function resolveAgentProfileValue<K extends 'name' | 'description' | 'avatarUrl'>(key: K): AgentProfileSettings[K] | NonNullable<ChatAgentSettingsPanelProps['agentProfile']>[K] | null {
  const defaultProfile = defaultAgentProfileSettings.value
  if (!props.agentProfile) {
    return defaultProfile?.[key] ?? null
  }

  if (defaultProfile?.profileId === props.agentProfile.profileId) {
    return defaultProfile[key] ?? props.agentProfile[key]
  }

  return props.agentProfile[key]
}
</script>

<template>
  <aside class="chat-agent-settings">
    <header class="chat-agent-settings__topbar">
      <ElButton
        v-if="currentView !== 'overview'"
        text
        class="chat-agent-settings__icon-btn h-8 min-w-8 w-8 rounded-lg p-0"
        :aria-label="t('chat.agentSettings.back')"
        @click="goBack"
      >
        <SvgIcon category="ui" icon="arrow-left" size="1rem" />
      </ElButton>
      <div class="chat-agent-settings__title">
        {{ panelTitle }}
      </div>
      <ElButton
        text
        class="chat-agent-settings__icon-btn h-8 min-w-8 w-8 rounded-lg p-0"
        :aria-label="t('chat.agentSettings.close')"
        @click="emits('close')"
      >
        <SvgIcon category="ui" icon="close" size="1rem" />
      </ElButton>
    </header>

    <section v-if="currentView === 'overview'" class="chat-agent-settings__body">
      <div class="chat-agent-settings__profile">
        <img class="chat-agent-settings__avatar" :src="agentAvatarUrl" :alt="agentName">
        <div class="chat-agent-settings__name">
          {{ agentName }}
        </div>
        <p class="chat-agent-settings__description">
          {{ agentDescription }}
        </p>
      </div>

      <section class="chat-agent-settings__section">
        <div class="chat-agent-settings__section-label">
          {{ t('chat.agentSettings.capabilitySection') }}
        </div>
        <div class="chat-agent-settings__rows">
          <button class="chat-agent-settings__row" type="button" @click="openSkills">
            <span class="chat-agent-settings__row-icon">
              <SvgIcon category="ui" icon="document-tree-file" size="1.125rem" />
            </span>
            <span class="chat-agent-settings__row-main">
              <span class="chat-agent-settings__row-title">{{ t('chat.agentSettings.skills') }}</span>
              <span class="chat-agent-settings__row-subtitle">{{ t('chat.agentSettings.skillsSubtitle') }}</span>
            </span>
            <SvgIcon category="ui" icon="chevron-right" size="1rem" class="chat-agent-settings__chevron" />
          </button>

          <button class="chat-agent-settings__row" type="button" @click="openMemories">
            <span class="chat-agent-settings__row-icon">
              <SvgIcon category="ui" icon="memory-note" size="1.125rem" />
            </span>
            <span class="chat-agent-settings__row-main">
              <span class="chat-agent-settings__row-title">{{ t('chat.agentSettings.memory') }}</span>
              <span class="chat-agent-settings__row-subtitle">{{ t('chat.agentSettings.memorySubtitle') }}</span>
            </span>
            <SvgIcon category="ui" icon="chevron-right" size="1rem" class="chat-agent-settings__chevron" />
          </button>

          <div class="chat-agent-settings__row chat-agent-settings__model-row">
            <span class="chat-agent-settings__row-icon">
              <SvgIcon category="ui" icon="settings-gear" size="1.125rem" />
            </span>
            <span class="chat-agent-settings__row-main">
              <span class="chat-agent-settings__row-title">{{ t('chat.agentSettings.defaultModel') }}</span>
              <span class="chat-agent-settings__row-subtitle">{{ t('chat.agentSettings.defaultModelSubtitle') }}</span>
            </span>
            <div class="chat-agent-settings__model-control">
              <ModelCascader
                class="chat-agent-settings__model-cascader"
                :model-value="defaultModelRef"
                :intent-key="AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT"
                :clearable="false"
                :filterable="true"
                :show-all-levels="false"
                :disabled="isDefaultModelLoading || isDefaultModelSaving"
                :placeholder="t('chat.agentSettings.modelPlaceholder')"
                @update:model-value="handleDefaultModelChange"
              />
            </div>
          </div>
        </div>
      </section>
    </section>

    <section v-else-if="currentView === 'skills'" class="chat-agent-settings__body">
      <p class="chat-agent-settings__section-copy">
        {{ t('chat.agentSettings.skillsCopy') }}
      </p>
      <div v-if="isLoadingSkills" class="chat-agent-settings__placeholder">
        {{ t('chat.agentSettings.loadingSkills') }}
      </div>
      <div v-else-if="installedSkills.length === 0" class="chat-agent-settings__placeholder">
        {{ t('chat.agentSettings.noSkills') }}
      </div>
      <div v-else class="chat-agent-settings__skill-list">
        <article
          v-for="skill in installedSkills"
          :key="skill.key"
          class="chat-agent-settings__skill-row"
          :class="{ 'is-disabled': !skill.enabled }"
        >
          <span class="chat-agent-settings__file-icon">
            <SvgIcon v-bind="resolveAgentSkillIcon(skill)" size="1.15rem" />
          </span>
          <span class="chat-agent-settings__row-main">
            <span class="chat-agent-settings__row-title">{{ skill.name }}</span>
            <ElTooltip
              :content="skill.description"
              placement="top"
              effect="dark"
              :show-after="300"
              :teleported="true"
              :popper-style="skillDescriptionTooltipStyle"
            >
              <span class="chat-agent-settings__row-subtitle">{{ skill.description }}</span>
            </ElTooltip>
          </span>
          <ElSwitch
            class="chat-agent-settings__skill-switch"
            :model-value="skill.enabled"
            :disabled="!canToggleSkill(skill) || isSkillUpdating(skill.key)"
            :loading="isSkillUpdating(skill.key)"
            :aria-label="skill.enabled ? t('chat.agentSettings.skillEnabled', { name: skill.name }) : t('chat.agentSettings.skillDisabled', { name: skill.name })"
            @change="handleSkillEnabledChange(skill.key, $event)"
          />
        </article>
      </div>
    </section>

    <section v-else-if="currentView === 'memories'" class="chat-agent-settings__body">
      <div v-if="isMemoryDocumentsLoading" class="chat-agent-settings__placeholder">
        {{ t('chat.agentSettings.loadingMemories') }}
      </div>
      <Empty
        v-else-if="memoryDocuments.length === 0"
        class="chat-agent-settings__empty"
        compact
        :description="t('chat.agentSettings.noMemory')"
      />
      <div v-else class="chat-agent-settings__memory-list">
        <button
          v-for="document in memoryDocuments"
          :key="document.id"
          class="chat-agent-settings__memory-row"
          type="button"
          @click="openMemoryDocument(document)"
        >
          <span class="chat-agent-settings__file-icon">
            <SvgIcon category="ui" icon="document-tree-file" size="1.15rem" />
          </span>
          <span class="chat-agent-settings__row-main">
            <span class="chat-agent-settings__row-title">{{ document.name }}</span>
            <span class="chat-agent-settings__row-subtitle">{{ document.summary }}</span>
            <span class="chat-agent-settings__file-meta">{{ document.sizeText }} · {{ document.updatedAtText }}</span>
          </span>
          <SvgIcon category="ui" icon="chevron-right" size="1rem" class="chat-agent-settings__chevron" />
        </button>
      </div>
    </section>

    <section v-else class="chat-agent-settings__body is-document">
      <article v-if="selectedMemoryDocument" class="chat-agent-settings__document">
        <div v-if="hasSelectedMemoryContent" class="chat-agent-settings__document-content">
          <div class="chat-agent-settings__document-meta">
            <span>{{ selectedMemoryDocument.updatedAtText }}</span>
            <span>{{ selectedMemoryDocument.sizeText }}</span>
          </div>
          <ChatMarkdownContent
            :message-id="`agent-memory-document:${selectedMemoryDocument.id}`"
            part-id="content"
            :source="selectedMemoryDocument.content"
            phase="final"
          />
        </div>
        <Empty
          v-else
          class="chat-agent-settings__empty"
          compact
          :description="t('chat.agentSettings.emptyMemoryDocument')"
        />
      </article>
    </section>
  </aside>
</template>

<style scoped lang="scss">
.chat-agent-settings {
  display: flex;
  width: clamp(22rem, 30vw, 30rem);
  min-width: 22rem;
  max-width: 30rem;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  border-left: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
  background: color-mix(in srgb, var(--brand-bg-surface) 96%, var(--brand-bg-body));
}

.chat-agent-settings__topbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 3.5rem;
  padding: 0 1rem;
  border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
}

.chat-agent-settings__title {
  overflow: hidden;
  min-width: 0;
  flex: 1;
  color: var(--brand-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-agent-settings__icon-btn {
  color: var(--brand-text-secondary);

  &:hover,
  &:focus-visible {
    color: var(--brand-primary);
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  }
}

.chat-agent-settings__body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 1.25rem 1rem;

  &.is-document {
    padding-top: 1rem;
  }
}

.chat-agent-settings__profile {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 0.5rem;
  text-align: center;
}

.chat-agent-settings__avatar {
  width: 3.25rem;
  height: 3.25rem;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  border-radius: 50%;
  object-fit: cover;
  box-shadow: var(--brand-shadow-hairline);
}

.chat-agent-settings__name {
  margin-top: 0.625rem;
  color: var(--brand-text-primary);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.5;
}

.chat-agent-settings__description {
  max-width: 42rem;
  margin: 0.75rem 0 0;
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.75;
}

.chat-agent-settings__section {
  margin-top: 1.5rem;
}

.chat-agent-settings__section-label {
  margin-bottom: 0.625rem;
  color: var(--brand-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.45;
}

.chat-agent-settings__section-copy {
  margin: 0 0 1rem;
  color: var(--brand-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.65;
}

.chat-agent-settings__rows,
.chat-agent-settings__skill-list,
.chat-agent-settings__memory-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.chat-agent-settings__placeholder {
  display: flex;
  min-height: 6rem;
  align-items: center;
  justify-content: center;
  color: var(--brand-text-tertiary);
  font-size: 0.875rem;
  line-height: 1.5;
}

.chat-agent-settings__empty {
  min-height: 10rem;
}

.chat-agent-settings__row,
.chat-agent-settings__skill-row,
.chat-agent-settings__memory-row {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-lighter) 70%, var(--brand-bg-surface));
  color: inherit;
  text-align: left;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    color 0.2s ease;
}

.chat-agent-settings__row {
  min-height: 4.25rem;
  padding: 0.875rem 1rem;
}

.chat-agent-settings__model-row {
  align-items: flex-start;
  flex-wrap: wrap;
}

button.chat-agent-settings__row,
.chat-agent-settings__memory-row {
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: color-mix(in srgb, var(--brand-primary) 22%, var(--brand-border-base));
    background: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
  }
}

.chat-agent-settings__skill-row,
.chat-agent-settings__memory-row {
  min-height: 5rem;
  padding: 0.875rem;
}

.chat-agent-settings__skill-row.is-disabled {
  .chat-agent-settings__row-title,
  .chat-agent-settings__row-subtitle {
    opacity: 0.58;
  }
}

.chat-agent-settings__row-icon,
.chat-agent-settings__file-icon {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--brand-bg-surface) 92%, transparent);
  color: var(--brand-text-primary);
}

.chat-agent-settings__file-icon {
  color: var(--brand-primary);
}

.chat-agent-settings__model-row .chat-agent-settings__row-icon {
  margin-top: 0.125rem;
}

.chat-agent-settings__row-main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.1875rem;
}

.chat-agent-settings__row-title {
  overflow: hidden;
  color: var(--brand-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-agent-settings__row-subtitle,
.chat-agent-settings__file-meta {
  color: var(--brand-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.45;
}

.chat-agent-settings__row-subtitle {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-agent-settings__model-control {
  width: calc(100% - 2.75rem);
  margin-left: 2.75rem;
}

.chat-agent-settings__skill-switch {
  flex: 0 0 auto;
}

.chat-agent-settings__model-cascader {
  width: 100%;

  :deep(.el-cascader) {
    width: 100%;
  }

  :deep(.el-cascader .el-input) {
    width: 100%;
  }
}

.chat-agent-settings__chevron {
  flex: 0 0 auto;
  color: var(--brand-text-tertiary);
}

.chat-agent-settings__document {
  min-width: 0;
}

.chat-agent-settings__document-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.75rem;
}

.chat-agent-settings__document-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem 0.625rem;
  align-items: center;
  justify-content: space-between;
  color: var(--brand-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.45;
}

@media (max-width: 768px) {
  .chat-agent-settings {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 12;
    width: min(100%, 26rem);
    min-width: 0;
    box-shadow: -1rem 0 2.25rem color-mix(in srgb, var(--brand-text-primary) 12%, transparent);
  }
}
</style>
