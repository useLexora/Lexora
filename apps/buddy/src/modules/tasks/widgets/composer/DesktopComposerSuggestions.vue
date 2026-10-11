<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatComposerContextOptions, ChatComposerSessionScope, ChatComposerTrigger, ChatPromptContextOption } from '@/modules/prompt-input'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import ChatComposerSourcePicker from './ChatComposerSourcePicker.vue'

const props = defineProps<{
  language: BuddyLocale
  trigger: ChatComposerTrigger | null
  contextOptions: ChatComposerContextOptions
  suggestionOptions: readonly ChatPromptContextOption[]
  loading: boolean
  contextLoadFailed: boolean
  deepSearch: boolean
  sessionScope?: ChatComposerSessionScope
  canManageSkills: boolean
}>()
const emit = defineEmits<{
  select: [option: ChatPromptContextOption, action?: 'complete' | 'select']
  navigate: [path: string]
  leaveSessions: []
  deepSearchChange: [value: boolean]
  manageSkills: []
}>()
const activeIndex = defineModel<number>('activeIndex', { required: true })
const { t } = useBuddyI18n(() => props.language)
const suggestionEmptyLabel = computed(() => {
  if (props.contextLoadFailed)
    return t('desktop.chat.sourcePickerLoadFailed')
  if (props.trigger?.kind === 'mention')
    return t(props.trigger.query ? 'desktop.chat.sourcePickerNoMatches' : 'desktop.chat.sourcePickerNoReferences')
  if (props.trigger?.kind === 'skill')
    return t(props.trigger.query ? 'desktop.chat.sourcePickerNoMatches' : 'desktop.chat.sourcePickerNoSkills')
  return t('desktop.chat.sourcePickerNoMatches')
})
</script>

<template>
  <ChatComposerSourcePicker
    :active-index="activeIndex"
    keyboard-navigation
    :accessible-label="t('desktop.chat.sourcePickerSuggestions')"
    :empty-label="suggestionEmptyLabel"
    :language="language"
    :loading="loading"
    :loading-label="t('desktop.chat.loadingContext')"
    :options="suggestionOptions"
    :directory="trigger?.kind === 'mention' ? contextOptions.directory : undefined"
    :deep-search="deepSearch"
    :session-scope="sessionScope"
    :has-more-sessions="contextOptions.hasMoreSessions"
    @leave-sessions="emit('leaveSessions')"
    @deep-search-change="emit('deepSearchChange', $event)"
    @navigate="emit('navigate', $event)"
    @highlight="activeIndex = $event"
    @enter-directory="emit('select', $event, 'complete')"
    @select="emit('select', $event)"
  >
    <template #extra>
      <NButton
        v-if="trigger?.kind === 'skill' && canManageSkills"
        class="text-[0.6rem] text-muted hover:text-accent-text"
        quaternary
        size="tiny"
        @mousedown.prevent
        @click="emit('manageSkills')"
      >
        {{ t('desktop.skills.manage') }}
      </NButton>
    </template>
  </ChatComposerSourcePicker>
</template>
