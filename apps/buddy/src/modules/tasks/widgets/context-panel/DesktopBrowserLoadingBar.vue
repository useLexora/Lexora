<script setup lang="ts">
import type { LoadingBarProviderInst } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NLoadingBarProvider } from 'naive-ui'
import { useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  loading: boolean
  failed: boolean
  language: BuddyLocale
}>()
const { t } = useBuddyI18n(() => props.language)
const provider = useTemplateRef<LoadingBarProviderInst>('provider')
watch([provider, () => props.loading], ([bar, loading], previous) => {
  if (!bar)
    return
  if (loading)
    bar.start()
  else if (previous?.[1])
    props.failed ? bar.error() : bar.finish()
}, { flush: 'post' })
</script>

<template>
  <div
    class="desktop-browser-loading-bar absolute inset-x-0 bottom-[-2px] z-3 h-[2px] overflow-hidden pointer-events-none"
    data-testid="browser-loading-bar"
    :role="loading ? 'progressbar' : undefined"
    :aria-label="loading ? t('desktop.context.browserLoading') : undefined"
    :aria-hidden="!loading"
  >
    <NLoadingBarProvider
      ref="provider"
      :to="false"
      :container-style="{ position: 'absolute', zIndex: 0 }"
      :theme-overrides="{ colorLoading: 'var(--buddy-accent-solid)', height: '2px' }"
    />
  </div>
</template>

<style scoped lang="scss">
@media (prefers-reduced-motion: reduce) {
  .desktop-browser-loading-bar :deep(.n-loading-bar),
  .desktop-browser-loading-bar :deep(.n-loading-bar-container) {
    transition-duration: 0.01ms !important;
  }
}
</style>
