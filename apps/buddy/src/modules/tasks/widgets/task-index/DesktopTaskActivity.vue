<script setup lang="ts">
import type { TaskActivity } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ApprovalsApp20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyChatActivitySpinner from '../transcript/BuddyChatActivitySpinner.vue'

const props = defineProps<{ activity: TaskActivity, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const label = computed(() => props.activity === 'awaiting_answer'
  ? t('activity.awaitingAnswer')
  : props.activity === 'awaiting_approval' ? t('activity.approval') : t('run.status.running'))
</script>

<template>
  <span
    class="pointer-events-none"
    :class="{
      'is-awaiting-answer text-warning': activity === 'awaiting_answer',
      'is-awaiting-approval text-warning': activity === 'awaiting_approval',
      'is-running': activity === 'running',
    }"
    role="status"
    :aria-label="label"
  >
    <BuddyChatActivitySpinner v-if="activity === 'running'" />
    <DesktopIcon v-else-if="activity === 'awaiting_answer'" name="messageAwaitingInput" :size="16" />
    <DesktopIcon v-else :component="ApprovalsApp20Regular" :size="16" />
  </span>
</template>
