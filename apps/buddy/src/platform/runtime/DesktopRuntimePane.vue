<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, inject } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopPaneBoundary from '@/shared/ui/loading/DesktopPaneBoundary.vue'
import { runtimeAvailabilityKey } from './runtimeAvailability'

const props = withDefaults(defineProps<{
  enabled?: boolean
  loading?: boolean
  language?: BuddyLocale
  animate?: boolean
}>(), { enabled: true, loading: false, animate: true })
const runtime = inject(runtimeAvailabilityKey, null)
const { t } = useBuddyI18n(() => props.language ?? runtime?.language.value ?? 'zh-CN')
const pending = computed(() => props.loading || (props.enabled && runtime?.loading.value) || false)
const error = computed(() => props.enabled && runtime?.failed.value ? t('desktop.loading.failed') : null)
</script>

<template>
  <DesktopPaneBoundary
    :animate="animate"
    :loading="pending"
    :error="error"
    :label="t('desktop.loading.pane')"
    :retry-label="t('desktop.loading.retry')"
    @retry="runtime?.retry()"
  >
    <slot />
  </DesktopPaneBoundary>
</template>
