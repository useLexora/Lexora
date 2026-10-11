<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ language: BuddyLocale, selected?: boolean }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="diagnostic-export-summary flex flex-col gap-4 pt-[0.3rem] text-fg text-[0.8125rem] leading-[1.7]">
    <section class="diagnostic-export-summary__section flex flex-col gap-[0.4rem]">
      <h3 class="diagnostic-export-summary__heading m-0">
        {{ t('applicationLogs.exportScope') }}
      </h3>
      <ul class="grid gap-[0.2rem] m-0 pl-5">
        <li>{{ t(selected ? 'applicationLogs.exportSelected' : 'applicationLogs.exportErrors') }}</li>
        <li>{{ t('applicationLogs.exportContext') }}</li>
      </ul>
      <p class="text-muted text-[0.75rem]">
        {{ t('applicationLogs.exportFilters') }}
      </p>
    </section>
    <section class="diagnostic-export-summary__section flex flex-col gap-[0.4rem]">
      <h3 class="diagnostic-export-summary__heading m-0">
        {{ t('applicationLogs.exportPrivacy') }}
      </h3>
      <p>{{ t('applicationLogs.exportPrivacyDescription') }}</p>
      <p class="text-muted text-[0.75rem]">
        {{ t('applicationLogs.exportLocalOnly') }}
      </p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.diagnostic-export-summary__section + .diagnostic-export-summary__section { border-top: 1px solid var(--buddy-border-subtle); padding-top: 1rem; }
.diagnostic-export-summary__heading { font-size: inherit; font-weight: 600; }

.diagnostic-export-summary p { margin: 0; }
</style>
