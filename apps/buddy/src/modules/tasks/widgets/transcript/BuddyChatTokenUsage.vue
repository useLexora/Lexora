<script setup lang="ts">
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { summarizeRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import { ArrowDown20Regular, ArrowUp20Regular, Database20Regular } from '@vicons/fluent'
import { NPopover } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyChatUsageDetails from './BuddyChatUsageDetails.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  compact?: boolean
  language: BuddyLocale
  usage: LocalRunTokenUsage
}>()

const { t } = useBuddyI18n(() => props.language)
const summary = computed(() => summarizeRunTokenUsage(props.usage))
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const showDetails = shallowRef(false)
const metrics = computed(() => [
  { key: 'input', label: t('desktop.chat.usage.input'), icon: ArrowDown20Regular, value: summary.value.inputTokens },
  { key: 'output', label: t('desktop.chat.usage.output'), icon: ArrowUp20Regular, value: summary.value.outputTokens },
  { key: 'cache', label: t('desktop.chat.usage.cache'), icon: Database20Regular, value: summary.value.cachedTokens },
])
</script>

<template>
  <NPopover v-model:show="showDetails" :delay="300" to=".buddy-app" trigger="hover">
    <template #trigger>
      <dl
        v-bind="$attrs" class="buddy-chat-token-usage inline-flex flex-none min-w-0 items-center gap-3 m-0 text-muted leading-[1] focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-focus focus-visible:outline-offset-[3px] focus-visible:rounded-micro" :class="{ 'is-compact': compact }" tabindex="0"
        @focus="showDetails = true" @blur="showDetails = false" @keydown.esc="showDetails = false"
      >
        <div v-for="metric in metrics" :key="metric.key" class="buddy-chat-token-usage__metric flex items-center gap-[0.25em] whitespace-nowrap" :data-usage-metric="metric.key">
          <dt :aria-label="metric.label">
            <DesktopIcon :component="metric.icon" aria-hidden="true" />
          </dt>
          <dd>{{ compactNumber.format(metric.value) }}</dd>
        </div>
      </dl>
    </template>
    <BuddyChatUsageDetails :language="language" :usage="usage" />
  </NPopover>
</template>

<style scoped lang="scss">
.buddy-chat-token-usage {
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;

  &.is-compact {
    gap: 6px;
    font-size: 10px;
  }
}

.buddy-chat-token-usage__metric {
  dt {
    display: flex;
    align-items: center;
    font-size: 1.2em;
  }

  dd {
    margin: 0;
    color: var(--buddy-text-secondary);
  }
}
</style>
