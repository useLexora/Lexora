<script setup lang="ts">
import type { Component } from 'vue'
import { Dismiss16Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

defineProps<{
  icon: Component
  label: string
  text: string
  removable?: boolean
  disabled?: boolean
  removeLabel: string
}>()
const emit = defineEmits<{ navigate: [], remove: [] }>()
</script>

<template>
  <div class="chat-reference-card flex w-[180px] max-w-full min-w-0 items-start border-1 border-solid border-border rounded-micro bg-raised">
    <button type="button" class="chat-reference-card__link flex flex-1 gap-[8px] min-w-0 py-[8px] px-[10px] border-0 bg-transparent text-fg text-left cursor-pointer hover:bg-hover ui-focus-ring focus-visible:rounded-micro" :title="text" @click="emit('navigate')">
      <DesktopIcon :component="icon" class="chat-reference-card__icon" />
      <span class="chat-reference-card__body grid min-w-0 gap-[3px]">
        <small>{{ label }}</small>
        <span class="chat-reference-card__excerpt overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] text-[12px] leading-[1.5]">{{ text }}</span>
      </span>
    </button>
    <NButton v-if="removable" class="buddy-icon-button chat-reference-card__remove" quaternary size="tiny" :disabled="disabled" :aria-label="removeLabel" @click="emit('remove')">
      <template #icon>
        <DesktopIcon :component="Dismiss16Regular" />
      </template>
    </NButton>
  </div>
</template>

<style scoped lang="scss">
.chat-reference-card { flex: 0 0 auto; }
.chat-reference-card__icon { flex: none; margin-top: 2px; color: var(--buddy-accent-text); }
.chat-reference-card__body small { color: var(--buddy-text-secondary); font-size: 11px; }
.chat-reference-card__excerpt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.chat-reference-card__remove { flex: none; margin: 4px 4px 0 0; }
</style>
