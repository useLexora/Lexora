<script setup lang="ts">
import type { DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { DocumentDismiss20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  state: DesktopBrowserState | null
  initializationFailed: boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useBuddyI18n(() => props.language)
const error = computed(() => props.initializationFailed ? null : props.state?.error)
const description = computed(() => {
  if (props.initializationFailed)
    return t('desktop.context.browserLoadFailed')
  switch (error.value?.code) {
    case 'BROWSER_CERTIFICATE_ERROR':
      return t('desktop.context.browserCertificateFailed')
    case 'BROWSER_NAVIGATION_BLOCKED':
    case 'BROWSER_PERMISSION_DENIED':
      return t('desktop.context.browserNavigationBlocked')
    case 'BROWSER_PAGE_CRASHED':
    case 'BROWSER_PAGE_UNRESPONSIVE':
      return t('desktop.context.browserPageUnavailable')
    default:
      return t('desktop.context.browserPageFailed')
  }
})
const failureCode = computed(() => error.value?.message.match(/^ERR_[A-Z_]+\b/)?.[0] ?? error.value?.code)
</script>

<template>
  <div
    class="absolute inset-0 flex items-center justify-center overflow-auto bg-surface px-6 py-8 text-fg"
    data-testid="browser-load-error"
    role="alert"
  >
    <div class="w-full max-w-[28rem] min-w-0 whitespace-normal">
      <DesktopIcon class="mb-5 text-muted" :size="40" :component="DocumentDismiss20Regular" aria-hidden="true" />
      <h2 class="m-0 mb-3 text-[20px] leading-normal font-600">
        {{ t('desktop.context.browserPageErrorTitle') }}
      </h2>
      <p class="m-0 text-[13px] leading-relaxed text-muted">
        {{ description }}
      </p>
      <p v-if="failureCode" class="m-0 mt-3 break-all text-[12px] font-mono text-muted">
        {{ failureCode }}
      </p>
      <div class="mt-8 flex justify-end">
        <NButton type="primary" @click="emit('retry')">
          {{ t('desktop.context.browserReload') }}
        </NButton>
      </div>
    </div>
  </div>
</template>
