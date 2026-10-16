<script setup lang="ts">
import type {
  AgentDocumentAssistantEditIntent,
  AgentTranslatorTargetLanguage,
} from '@haohaoxue/lexora-contracts/agent'
import type { DropdownInstance, InputInstance } from 'element-plus'
import type {
  ChatComposerSkillControlsEmits,
  ChatComposerSkillControlsProps,
} from './typing'
import { ArrowDown, Check, CloseBold } from '@element-plus/icons-vue'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_TRANSLATOR_PRESET_TARGET_LANGUAGES,
} from '@haohaoxue/lexora-contracts/agent'
import { computed, nextTick, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<ChatComposerSkillControlsProps>()
const emit = defineEmits<ChatComposerSkillControlsEmits>()
const { t } = useI18n({ useScope: 'global' })

const SKILL_TRANSLATOR_COMMAND = 'translator'
const SKILL_DOCUMENT_ASSISTANT_COMMAND = 'document-assistant'
const TRANSLATOR_CUSTOM_LANGUAGE_COMMAND = '__custom__'
const AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT_VALUES = [
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION,
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR,
] as const
const skillCommandDropdownRef = shallowRef<DropdownInstance>()
const customLanguageInputRef = shallowRef<InputInstance>()
const customLanguageEditing = shallowRef(false)
const customLanguageDraft = shallowRef('')

const translatorParameterDropdownDisabled = computed(() =>
  Boolean(props.disabled || props.isStreaming || !props.translatorSkillEnabled),
)
const documentAssistantParameterDropdownDisabled = computed(() =>
  Boolean(props.disabled || props.isStreaming || !props.documentAssistantSkillEnabled),
)
const skillCommandDropdownDisabled = computed(() =>
  Boolean(props.disabled || props.isStreaming),
)
const skillCommandTooltip = computed(() =>
  props.isStreaming ? t('chat.composer.selectSkillDisabled') : t('chat.composer.selectSkill'),
)
const customLanguageSubmitDisabled = computed(() => !customLanguageDraft.value.trim())
const customTranslatorTargetSelected = computed(() =>
  Boolean(props.translatorTargetLanguage && !props.translatorTargetLanguage.tag),
)
const translatorTargetName = computed(() => props.translatorTargetLanguage?.name ?? '')
const activeSkillSelected = computed(() =>
  Boolean(props.translatorTargetLanguage || props.documentAssistantEditIntent),
)
const commandMenuHasSkills = computed(() =>
  Boolean(props.translatorSkillEnabled || props.documentAssistantSkillEnabled),
)
const documentAssistantIntentLabel = computed(() =>
  getDocumentAssistantIntentLabel(props.documentAssistantEditIntent ?? AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION),
)

watch(
  () => props.skillCommandOpenSignal,
  async (signal, previousSignal) => {
    if (
      !signal
      || signal === previousSignal
      || activeSkillSelected.value
      || skillCommandDropdownDisabled.value
    ) {
      return
    }

    await nextTick()
    skillCommandDropdownRef.value?.handleOpen()
  },
)

watch(
  () => [props.disabled, props.isStreaming, props.translatorTargetLanguage, props.documentAssistantEditIntent] as const,
  ([disabled, isStreaming, targetLanguage, documentAssistantIntent]) => {
    if (disabled || isStreaming || !targetLanguage || documentAssistantIntent) {
      customLanguageEditing.value = false
    }
  },
)

function handleTranslatorCommand(command: string | number | object) {
  const commandValue = String(command)
  if (commandValue === TRANSLATOR_CUSTOM_LANGUAGE_COMMAND) {
    void openCustomTranslatorLanguageInput()
    return
  }

  const language = AGENT_TRANSLATOR_PRESET_TARGET_LANGUAGES.find(item => item.tag === commandValue)
  if (!language) {
    return
  }

  customLanguageEditing.value = false
  emit('update:translatorTargetLanguage', language)
}

function handleSkillCommand(command: string | number | object) {
  const commandValue = String(command)
  if (commandValue === SKILL_TRANSLATOR_COMMAND) {
    emit('update:documentAssistantEditIntent', null)
    emit('update:translatorTargetLanguage', getDefaultTranslatorTargetLanguage())
    return
  }

  if (commandValue === SKILL_DOCUMENT_ASSISTANT_COMMAND) {
    customLanguageEditing.value = false
    emit('update:translatorTargetLanguage', null)
    emit('update:documentAssistantEditIntent', AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION)
  }
}

function handleDocumentAssistantCommand(command: string | number | object) {
  const intent = String(command)
  if (!isDocumentAssistantEditIntent(intent)) {
    return
  }

  emit('update:documentAssistantEditIntent', intent)
}

function clearTranslatorSkill() {
  customLanguageEditing.value = false
  emit('update:translatorTargetLanguage', null)
}

function clearDocumentAssistantSkill() {
  emit('update:documentAssistantEditIntent', null)
}

function getDefaultTranslatorTargetLanguage() {
  return { ...AGENT_TRANSLATOR_PRESET_TARGET_LANGUAGES[0] }
}

function isTranslatorTargetSelected(language: AgentTranslatorTargetLanguage) {
  return props.translatorTargetLanguage?.tag === language.tag
}

function isDocumentAssistantIntentSelected(intent: AgentDocumentAssistantEditIntent) {
  return props.documentAssistantEditIntent === intent
}

function isDocumentAssistantEditIntent(intent: string): intent is AgentDocumentAssistantEditIntent {
  return (AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT_VALUES as readonly string[]).includes(intent)
}

function getDocumentAssistantIntentLabel(intent: AgentDocumentAssistantEditIntent) {
  if (intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
    return t('chat.composer.documentAssistantContinue')
  }

  return t('chat.composer.documentAssistantRewrite')
}

async function openCustomTranslatorLanguageInput() {
  customLanguageDraft.value = customTranslatorTargetSelected.value
    ? props.translatorTargetLanguage?.name ?? ''
    : ''
  customLanguageEditing.value = true
  await nextTick()
  customLanguageInputRef.value?.focus()
}

function confirmCustomTranslatorLanguage() {
  const name = customLanguageDraft.value.trim()
  if (!name) {
    return
  }

  customLanguageDraft.value = name
  customLanguageEditing.value = false
  emit('update:translatorTargetLanguage', { name })
}

function cancelCustomTranslatorLanguageInput() {
  customLanguageEditing.value = false
}
</script>

<template>
  <ElTooltip v-if="!activeSkillSelected" :content="skillCommandTooltip" placement="top">
    <span>
      <ElDropdown
        ref="skillCommandDropdownRef"
        trigger="click"
        :disabled="skillCommandDropdownDisabled"
        @command="handleSkillCommand"
      >
        <button
          class="chat-composer-toolbar__icon-button"
          type="button"
          :disabled="skillCommandDropdownDisabled"
          :aria-label="t('chat.composer.selectSkill')"
        >
          <span class="chat-composer-toolbar__symbol">/</span>
        </button>

        <template #dropdown>
          <ElDropdownMenu class="chat-composer-toolbar__command-menu">
            <template v-if="commandMenuHasSkills">
              <ElDropdownItem
                v-if="props.translatorSkillEnabled"
                :command="SKILL_TRANSLATOR_COMMAND"
                class="chat-composer-toolbar__command-item"
              >
                <span class="chat-composer-toolbar__command-main">
                  <SvgIcon category="ai" icon="translate" size="1rem" />
                  <span>{{ t('chat.composer.translate') }}</span>
                </span>
              </ElDropdownItem>

              <ElDropdownItem
                v-if="props.documentAssistantSkillEnabled"
                :command="SKILL_DOCUMENT_ASSISTANT_COMMAND"
                class="chat-composer-toolbar__command-item"
              >
                <span class="chat-composer-toolbar__command-main">
                  <SvgIcon category="ui" icon="document-tree-file" size="1rem" />
                  <span>{{ t('chat.composer.documentAssistant') }}</span>
                </span>
              </ElDropdownItem>
            </template>

            <ElDropdownItem
              v-else
              disabled
              class="chat-composer-toolbar__command-empty"
            >
              {{ t('chat.composer.noSkills') }}
            </ElDropdownItem>
          </ElDropdownMenu>
        </template>
      </ElDropdown>
    </span>
  </ElTooltip>

  <div v-else-if="props.translatorTargetLanguage" class="chat-composer-toolbar__selected-skill">
    <span class="chat-composer-toolbar__skill-chip">
      <SvgIcon class="chat-composer-toolbar__skill-icon" category="ai" icon="translate" size="1rem" />
      <ElTooltip :content="t('chat.composer.exitSkillTooltip')" placement="top" effect="dark">
        <button
          class="chat-composer-toolbar__skill-close"
          type="button"
          :aria-label="t('chat.composer.exitSkill')"
          @click="clearTranslatorSkill"
        >
          <ElIcon><CloseBold /></ElIcon>
        </button>
      </ElTooltip>
    </span>

    <div v-if="customLanguageEditing" class="chat-composer-toolbar__parameter-edit">
      <span class="chat-composer-toolbar__parameter-prefix">{{ t('chat.composer.translateTo') }}</span>
      <ElInput
        ref="customLanguageInputRef"
        v-model="customLanguageDraft"
        class="chat-composer-toolbar__parameter-value chat-composer-toolbar__parameter-input"
        :aria-label="t('chat.composer.customTargetLanguage')"
        :placeholder="t('chat.composer.targetLanguage')"
        maxlength="10"
        @keydown.enter.stop.prevent="confirmCustomTranslatorLanguage"
        @keydown.esc.stop.prevent="cancelCustomTranslatorLanguageInput"
      />
      <button
        class="chat-composer-toolbar__parameter-action"
        type="button"
        :disabled="customLanguageSubmitDisabled"
        :aria-label="t('chat.composer.confirmTargetLanguage')"
        @click="confirmCustomTranslatorLanguage"
      >
        <ElIcon><Check /></ElIcon>
      </button>
      <button
        class="chat-composer-toolbar__parameter-action"
        type="button"
        :aria-label="t('chat.composer.cancelInput')"
        @click="cancelCustomTranslatorLanguageInput"
      >
        <ElIcon><CloseBold /></ElIcon>
      </button>
    </div>

    <ElDropdown
      v-else
      trigger="click"
      :disabled="translatorParameterDropdownDisabled"
      @command="handleTranslatorCommand"
    >
      <button
        class="chat-composer-toolbar__parameter-button"
        type="button"
        :disabled="translatorParameterDropdownDisabled"
        :aria-label="t('chat.composer.translateToAria', { language: translatorTargetName })"
      >
        <span class="chat-composer-toolbar__parameter-prefix">{{ t('chat.composer.translateTo') }}</span>
        <span class="chat-composer-toolbar__parameter-value">{{ translatorTargetName }}</span>
        <ElIcon class="chat-composer-toolbar__parameter-arrow">
          <ArrowDown />
        </ElIcon>
      </button>

      <template #dropdown>
        <ElDropdownMenu class="chat-composer-toolbar__translate-menu">
          <ElDropdownItem
            v-for="language in AGENT_TRANSLATOR_PRESET_TARGET_LANGUAGES"
            :key="language.tag"
            :command="language.tag"
            class="chat-composer-toolbar__translate-item"
            :class="{ 'is-selected': isTranslatorTargetSelected(language) }"
          >
            {{ language.name }}
          </ElDropdownItem>

          <ElDropdownItem
            divided
            :command="TRANSLATOR_CUSTOM_LANGUAGE_COMMAND"
            class="chat-composer-toolbar__translate-item"
            :class="{ 'is-selected': customTranslatorTargetSelected }"
          >
            {{ t('chat.composer.other') }}
          </ElDropdownItem>
        </ElDropdownMenu>
      </template>
    </ElDropdown>
  </div>

  <div v-else-if="props.documentAssistantEditIntent" class="chat-composer-toolbar__selected-skill">
    <span class="chat-composer-toolbar__skill-chip">
      <SvgIcon class="chat-composer-toolbar__skill-icon" category="ui" icon="document-tree-file" size="1rem" />
      <ElTooltip :content="t('chat.composer.exitSkillTooltip')" placement="top" effect="dark">
        <button
          class="chat-composer-toolbar__skill-close"
          type="button"
          :aria-label="t('chat.composer.exitSkill')"
          @click="clearDocumentAssistantSkill"
        >
          <ElIcon><CloseBold /></ElIcon>
        </button>
      </ElTooltip>
    </span>

    <ElDropdown
      trigger="click"
      :disabled="documentAssistantParameterDropdownDisabled"
      @command="handleDocumentAssistantCommand"
    >
      <button
        class="chat-composer-toolbar__parameter-button"
        type="button"
        :disabled="documentAssistantParameterDropdownDisabled"
        :aria-label="t('chat.composer.documentAssistantModeAria', { mode: documentAssistantIntentLabel })"
      >
        <span class="chat-composer-toolbar__parameter-prefix">{{ t('chat.composer.documentAssistantMode') }}</span>
        <span class="chat-composer-toolbar__parameter-value">{{ documentAssistantIntentLabel }}</span>
        <ElIcon class="chat-composer-toolbar__parameter-arrow">
          <ArrowDown />
        </ElIcon>
      </button>

      <template #dropdown>
        <ElDropdownMenu class="chat-composer-toolbar__command-menu">
          <ElDropdownItem
            :command="AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION"
            class="chat-composer-toolbar__command-item"
            :class="{ 'is-selected': isDocumentAssistantIntentSelected(AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION) }"
          >
            {{ t('chat.composer.documentAssistantRewrite') }}
          </ElDropdownItem>

          <ElDropdownItem
            :command="AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR"
            class="chat-composer-toolbar__command-item"
            :class="{ 'is-selected': isDocumentAssistantIntentSelected(AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) }"
          >
            {{ t('chat.composer.documentAssistantContinue') }}
          </ElDropdownItem>
        </ElDropdownMenu>
      </template>
    </ElDropdown>
  </div>
</template>
