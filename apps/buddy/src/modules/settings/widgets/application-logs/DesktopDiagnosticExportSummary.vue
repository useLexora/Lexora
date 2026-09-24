<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ language: BuddyLocale, selected?: boolean }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="diagnostic-export-summary">
    <section class="diagnostic-export-summary__section">
      <h3 class="diagnostic-export-summary__heading">
        {{ t('applicationLogs.exportScope') }}
      </h3>
      <ul class="diagnostic-export-summary__list">
        <li>{{ t(selected ? 'applicationLogs.exportSelected' : 'applicationLogs.exportErrors') }}</li>
        <li>{{ t('applicationLogs.exportContext') }}</li>
      </ul>
      <p class="diagnostic-export-summary__hint">
        {{ t('applicationLogs.exportFilters') }}
      </p>
    </section>
    <section class="diagnostic-export-summary__section">
      <h3 class="diagnostic-export-summary__heading">
        {{ t('applicationLogs.exportPrivacy') }}
      </h3>
      <p>{{ t('applicationLogs.exportPrivacyDescription') }}</p>
      <p class="diagnostic-export-summary__hint">
        {{ t('applicationLogs.exportLocalOnly') }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.diagnostic-export-summary { display: flex; flex-direction: column; gap: 1rem; padding-top: 0.3rem; color: var(--buddy-text-primary); font-size: 0.8125rem; line-height: 1.7; }
.diagnostic-export-summary__section { display: flex; flex-direction: column; gap: 0.4rem; }
.diagnostic-export-summary__section + .diagnostic-export-summary__section { border-top: 1px solid var(--buddy-border-subtle); padding-top: 1rem; }
.diagnostic-export-summary__heading { margin: 0; font-size: inherit; font-weight: 600; }
.diagnostic-export-summary__list { display: grid; gap: 0.2rem; margin: 0; padding-left: 1.25rem; }
.diagnostic-export-summary p { margin: 0; }
.diagnostic-export-summary__hint { color: var(--buddy-text-secondary); font-size: 0.75rem; }
</style>
