<script setup lang="ts">
import type { AutomationPreviewState } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatAutomationInstant } from '../../model/automationPresentation'

const props = defineProps<{
  language: BuddyLocale
  state: AutomationPreviewState
  timezone: string
}>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section class="desktop-automation-editor__preview grid gap-[14px] border-t-1 border-t-solid border-t-border mt-[6px] pt-[22px]">
    <div class="desktop-automation-editor__section-heading grid gap-[3px]">
      <h2>{{ t('desktop.automations.editor.preview') }}</h2>
    </div>
    <NAlert v-if="state.status === 'loading'" type="info" :bordered="false">
      {{ t('desktop.automations.refresh') }}…
    </NAlert>
    <NAlert v-else-if="state.status === 'ready' && state.result.valid" type="success" :bordered="false">
      <strong>{{ t('desktop.automations.editor.nextRun', {
        time: formatAutomationInstant(state.result.nextRunAt, language, timezone),
      }) }}</strong>
      <ul>
        <li v-for="sample in state.result.samples" :key="sample">
          {{ formatAutomationInstant(sample, language, timezone) }}
        </li>
      </ul>
    </NAlert>
    <NAlert v-else type="warning" :bordered="false">
      {{ t('desktop.automations.editor.previewInvalid') }}
    </NAlert>
  </section>
</template>

<style scoped lang="scss">
.desktop-automation-editor__preview {
  ul {
    display: grid;
    margin: 8px 0 0;
    gap: 3px;
    padding-left: 18px;
  }
}

.desktop-automation-editor__section-heading {
  h2 {
    margin: 0;
    color: var(--buddy-text-strong);
    font-size: 14px;
    font-weight: 660;
  }
}
</style>
