<script setup lang="ts">
import type { FeatureDiscovery } from '../state/useFeatureDiscovery'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss20Regular } from '@vicons/fluent'
import { useActiveElement, useDocumentVisibility, useWindowFocus } from '@vueuse/core'
import { NButton, NModal } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useFeatureGuideHints } from '../state/useFeatureGuideHints'
import FeatureReleaseBrowser from './FeatureReleaseBrowser.vue'

const props = defineProps<{ controller: FeatureDiscovery, language: BuddyLocale, canRemind: boolean }>()
const state = props.controller
const { opened, busy, features, unread, unannounced, initialized, announcementsEnabled } = state
const { t } = useBuddyI18n(() => props.language)
const focused = useWindowFocus()
const visibility = useDocumentVisibility()
const activeElement = useActiveElement()
const editing = computed(() => !!activeElement.value?.closest('input, textarea, [contenteditable="true"]'))
const reminderVisible = computed(() => announcementsEnabled.value && props.canRemind && initialized.value && !opened.value && !state.active.value && unannounced.value.length > 0 && focused.value && visibility.value === 'visible' && !editing.value)
useFeatureGuideHints(state, () => props.language)
</script>

<template>
  <aside v-if="reminderVisible" class="absolute right-4 top-12 z-20 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-[8px] border border-solid border-border bg-raised px-4 py-3 shadow-overlay" role="status" data-testid="feature-discovery-reminder">
    <span class="text-[13px] text-fg">{{ t('discovery.reminderTitle', { count: unannounced.length }) }}</span>
    <NButton size="small" secondary :disabled="busy" @click="state.open()">
      {{ t('discovery.view') }}
    </NButton>
    <NButton class="buddy-icon-button" quaternary size="small" :disabled="busy" :aria-label="t('discovery.dismiss')" @click="state.dismissReminder()">
      <DesktopIcon :component="Dismiss20Regular" :size="16" />
    </NButton>
  </aside>
  <NModal :show="opened" preset="card" class="feature-discovery-dialog w-[min(760px,calc(100vw-3rem))]" :title="t('discovery.title')" :bordered="false" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @update:show="opened = $event">
    <p class="m-0 mb-4 text-[13px] leading-relaxed text-muted">
      {{ t('discovery.description') }}
    </p>
    <FeatureReleaseBrowser v-if="opened" :features="features" :unread="unread" :language="language" :busy="busy" @visit="state.visit" @start-release="state.startRelease" />
  </NModal>
</template>
