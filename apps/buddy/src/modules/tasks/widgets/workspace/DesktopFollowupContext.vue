<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NTooltip } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, preview: string, disabled: boolean }>()
const emit = defineEmits<{ cancel: [], locate: [] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section class="desktop-followup-context grid min-w-0 gap-1 border-1 border-solid border-accent-border rounded-[8px] bg-accent-subtle px-3 py-2 text-[12px]" data-testid="chat-followup-context">
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <div class="flex flex-1 items-center gap-2 text-accent-text" role="status">
        <DesktopIcon name="messageBranch" class="text-[16px]" />
        <span>{{ t('desktop.chat.followupTarget') }}</span>
      </div>
      <NButton size="tiny" quaternary :disabled="disabled" @click="emit('locate')">
        {{ t('desktop.chat.locateFollowup') }}
      </NButton>
      <NTooltip placement="top">
        <template #trigger>
          <NButton size="tiny" quaternary :disabled="disabled" @click="emit('cancel')">
            {{ t('desktop.chat.cancelFollowup') }}
          </NButton>
        </template>
        {{ t('desktop.chat.cancelFollowupHint') }}
      </NTooltip>
    </div>
    <p class="m-0 truncate text-fg" data-testid="followup-source-preview">
      {{ preview || t('desktop.chat.followupSource') }}
    </p>
    <p class="m-0 text-muted leading-[1.6]">
      {{ t('desktop.chat.followupHint') }}
    </p>
  </section>
</template>
