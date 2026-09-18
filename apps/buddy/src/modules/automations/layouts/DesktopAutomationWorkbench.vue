<script setup lang="ts">
import type { AutomationCapability } from '../state/typing'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  Add20Regular,
  ArrowClockwise20Regular,
} from '@vicons/fluent'
import { NButton, NScrollbar, useMessage } from 'naive-ui'
import { shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  automations: AutomationCapability
  language: BuddyLocale
}>()
const emit = defineEmits<{
  add: []
}>()
defineSlots<{
  default: () => unknown
}>()
const route = useRoute()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const isRefreshing = shallowRef(false)

async function refresh(): Promise<void> {
  if (isRefreshing.value)
    return
  isRefreshing.value = true
  try {
    if (!await props.automations.refresh() && props.automations.loadError.value)
      message.error(props.automations.loadError.value)
  }
  finally {
    isRefreshing.value = false
  }
}
</script>

<template>
  <section class="desktop-automation-workbench">
    <header class="desktop-automation-workbench__header">
      <div class="desktop-automation-workbench__primary">
        <nav :aria-label="t('desktop.automations.title')">
          <RouterLink
            :class="{ 'is-active': route.meta.automationSection === 'plans' }"
            :to="desktopRouteLocations.automations('plans')"
          >
            {{ t('desktop.automations.plans') }}
          </RouterLink>
          <RouterLink
            :class="{ 'is-active': route.meta.automationSection === 'history' }"
            :to="desktopRouteLocations.automations('history')"
          >
            {{ t('desktop.automations.history') }}
          </RouterLink>
        </nav>
      </div>
      <div class="desktop-automation-workbench__header-actions">
        <NButton size="small" secondary :loading="isRefreshing" @click="refresh">
          <template #icon>
            <DesktopIcon :component="ArrowClockwise20Regular" :size="16" />
          </template>
          {{ t('desktop.automations.refresh') }}
        </NButton>
        <NButton size="small" type="primary" @click="emit('add')">
          <template #icon>
            <DesktopIcon :component="Add20Regular" :size="16" />
          </template>
          {{ t('desktop.automations.add') }}
        </NButton>
      </div>
    </header>

    <NScrollbar
      class="desktop-automation-workbench__scroll"
      content-style="min-height: 100%;"
    >
      <div class="desktop-automation-workbench__content">
        <slot />
      </div>
    </NScrollbar>
  </section>
</template>

<style scoped lang="scss">
.desktop-automation-workbench {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--buddy-surface-base);
}

.desktop-automation-workbench__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0 18px;
}

.desktop-automation-workbench__primary,
.desktop-automation-workbench__header-actions {
  display: flex;
  align-items: center;
}

.desktop-automation-workbench__primary {
  min-width: 0;
  gap: 8px;

  nav {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
    background: var(--buddy-surface-subtle);
    padding: 2px;
  }

  nav > a {
    border-radius: 4px;
    color: var(--buddy-text-secondary);
    font-size: 13px;
    font-weight: 580;
    line-height: 1;
    padding: 7px 12px;
    text-decoration: none;
  }

  nav > a:hover {
    color: var(--buddy-text-strong);
  }

  nav > a:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: 1px;
  }

  nav > a.is-active {
    background: var(--buddy-surface-base);
    box-shadow: var(--buddy-shadow-soft);
    color: var(--buddy-text-strong);
  }
}

.desktop-automation-workbench__header-actions {
  flex: none;
  gap: 8px;
}

.desktop-automation-workbench__scroll {
  min-height: 0;
  flex: 1;
}

.desktop-automation-workbench__content {
  display: flex;
  min-height: 100%;
  box-sizing: border-box;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 36px;

  > :deep(.desktop-automation-route-view) {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
  }
}

@media (max-width: 760px) {
  .desktop-automation-workbench__header {
    padding: 0 12px;
  }

  .desktop-automation-workbench__header-actions .n-button:first-of-type {
    display: none;
  }

  .desktop-automation-workbench__content {
    padding: 10px 12px 28px;
  }
}
</style>
