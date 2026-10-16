<script setup lang="ts">
import type {
  ChatContextBarEmits,
  ChatContextBarProps,
} from './typing'
import { useI18n } from 'vue-i18n'
import ChatUsagePopover from '../../components/usage-popover'

const props = defineProps<ChatContextBarProps>()
const emits = defineEmits<ChatContextBarEmits>()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <div class="chat-view-context flex w-full flex-wrap items-center justify-end gap-4">
    <div class="flex items-center gap-2">
      <ChatUsagePopover :usage="props.conversationUsage" />
      <ElTooltip :content="t('chat.workspace.agentSettings')" placement="bottom">
        <ElButton
          text
          class="chat-view-context__agent-btn h-8 min-w-8 w-8 rounded-lg p-0"
          :class="{ 'is-active': props.isAgentSettingsOpen }"
          :aria-label="t('chat.workspace.agentSettings')"
          @click="emits('toggleAgentSettings')"
        >
          <SvgIcon category="ai" icon="agents" size="1.25rem" />
        </ElButton>
      </ElTooltip>
      <ElButton class="chat-view-context__new-chat-btn h-8 rounded-lg px-3 text-sm font-medium" @click="emits('newChat')">
        <span class="inline-flex items-center gap-1.5">
          <SvgIcon category="ui" icon="plus" size="0.875rem" />
          <span>{{ t('chat.workspace.newChat') }}</span>
        </span>
      </ElButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-view-context__new-chat-btn {
  border-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  background: color-mix(in srgb, var(--brand-fill-light) 42%, var(--brand-bg-surface));
  color: var(--brand-text-primary);
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    color 0.2s ease;

  &:hover,
  &:focus-visible {
    border-color: color-mix(in srgb, var(--brand-primary) 28%, var(--brand-border-base));
    background: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
    color: var(--brand-primary);
  }
}

.chat-view-context__agent-btn {
  color: var(--brand-text-secondary);
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  background: color-mix(in srgb, var(--brand-bg-surface) 92%, transparent);
  box-shadow: var(--brand-shadow-hairline);

  &:hover,
  &:focus-visible,
  &.is-active {
    color: var(--brand-primary);
    background: color-mix(in srgb, var(--brand-primary) 7%, var(--brand-bg-surface));
  }
}
</style>
