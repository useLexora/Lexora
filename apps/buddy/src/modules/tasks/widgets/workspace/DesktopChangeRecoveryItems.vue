<script setup lang="ts">
import type { LocalChangeRecoveryItem } from '@buddy-shared/changes/changeApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  items: readonly LocalChangeRecoveryItem[]
  language: BuddyLocale
}>()
const { t } = useBuddyI18n(() => props.language)

function occurredAt(value: string) {
  return new Intl.DateTimeFormat(props.language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <ul class="m-0 grid max-h-[180px] list-none gap-2 overflow-y-auto p-0">
    <li v-for="item in items" :key="item.invocationId" class="min-w-0 break-words">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <strong>{{ item.taskTitle || t(item.conversationId ? 'desktop.chat.changeRecovery.untitledTask' : 'desktop.chat.changeRecovery.deletedTask') }}</strong>
        <time class="text-[11px] text-muted" :datetime="item.occurredAt">{{ occurredAt(item.occurredAt) }}</time>
      </div>
      <p class="m-0 text-[12px]">
        {{ t(`desktop.chat.changeRecovery.${item.status}`) }}
      </p>
      <ul v-if="item.affectedResources.length" class="m-0 list-none p-0 font-mono text-[12px]">
        <li v-for="resource in item.affectedResources" :key="resource" class="[overflow-wrap:anywhere]">
          {{ resource }}
        </li>
      </ul>
      <p v-else class="m-0 text-[12px]">
        {{ t('desktop.chat.changeRecovery.unknownLocation') }}
      </p>
    </li>
  </ul>
</template>
