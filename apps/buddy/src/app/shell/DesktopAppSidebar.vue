<script setup lang="ts">
import type { DesktopAppInfo, DesktopUserProfileConfig } from '@buddy-electron/shared/desktopApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopNotification } from '@/modules/notifications/contracts'
import type { DesktopNavigationEntry } from '@/shared/navigation/desktopPages'
import { Alert20Regular } from '@vicons/fluent'
import { NBadge, NButton, NPopover } from 'naive-ui'
import { computed, shallowRef, useTemplateRef } from 'vue'
import DesktopAccountAvatar from '@/app/shell/DesktopAccountAvatar.vue'
import DesktopAccountDialog from '@/app/shell/DesktopAccountDialog.vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopNotificationCenter } from '@/modules/notifications/ui'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import WorkbenchMountPoint from '@/workbench/browser/mounts/WorkbenchMountPoint.vue'
import { resolveUserProfile } from './userProfile'

const props = defineProps<{
  appInfo?: DesktopAppInfo | null
  appVersion: string | null
  navigation: readonly DesktopNavigationEntry[]
  language: BuddyLocale
  notificationItems: ReadonlyArray<DesktopNotification>
  notificationLoading: boolean
  notificationUnseenCount: number
  profileConfig?: DesktopUserProfileConfig | null
  updateProfile: (patch: Partial<DesktopUserProfileConfig>) => Promise<boolean>
}>()
const emit = defineEmits<{
  markAllNotificationsSeen: []
  navigate: [id: string]
  openNotification: [notification: DesktopNotification]
  refreshNotifications: []
}>()
const sidebar = useTemplateRef<HTMLElement>('sidebar')
useWorkbenchAnchor('app.sidebar', () => sidebar.value)
const { t } = useBuddyI18n(() => props.language)
const versionLabel = computed(() => props.appVersion ? `v${props.appVersion}` : '')
const showAccountDialog = shallowRef(false)
const showNotifications = shallowRef(false)
const notificationPopoverThemeOverrides = { padding: '0' } as const

const resolvedProfile = computed(() => resolveUserProfile(props.profileConfig, props.appInfo))

function updateNotificationVisibility(show: boolean) {
  showNotifications.value = show
  if (show)
    emit('refreshNotifications')
}

function openNotification(notification: DesktopNotification) {
  showNotifications.value = false
  emit('openNotification', notification)
}
</script>

<template>
  <aside id="desktop-app-sidebar" ref="sidebar" class="desktop-app-sidebar flex w-app-sidebar h-full min-h-0 flex-none flex-col overflow-hidden border-r-1 border-r-solid border-r-border bg-app-sidebar text-app-sidebar-fg">
    <WorkbenchMountPoint target="app.sidebar">
      <header class="flex flex-none items-center justify-between gap-[0.65rem] border-b-1 border-b-solid border-b-border py-0 px-3 h-region-header">
        <div class="flex min-w-0 items-baseline gap-2">
          <strong class="truncate text-strong text-sidebar-header [font-weight:var(--buddy-sidebar-header-font-weight)]">Lexora Buddy</strong>
          <span class="flex-none truncate text-muted text-[11px]">{{ versionLabel }}</span>
        </div>
      </header>

      <nav class="grid min-h-0 flex-1 content-start gap-[0.125rem] p-2 overflow-y-auto">
        <button v-for="item in navigation" :key="item.id" class="desktop-app-sidebar__nav-item flex w-full min-h-9 items-center gap-[0.625rem] border-0 rounded-icon cursor-pointer text-sidebar-item [font-weight:var(--buddy-sidebar-item-font-weight)] leading-[20px] py-2 px-[0.625rem] text-left ui-focus-ring transition-state-colors" :class="item.active ? 'is-active bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'bg-transparent text-app-sidebar-fg hover:(bg-hover text-strong) active:bg-nav-pressed'" :aria-current="item.active ? 'page' : undefined" :data-extension-navigation="item.extensionId" type="button" @click="emit('navigate', item.id)">
          <DesktopPluginIcon v-if="item.icon.kind === 'plugin'" :src="item.icon.url" />
          <DesktopIcon v-else-if="item.icon.kind === 'named'" :name="item.icon.name" />
          <DesktopIcon v-else class="desktop-app-sidebar__extension-icon flex-none origin-center [transform:translateY(-0.025em)_scale(1.12)]" :component="item.icon.component" />
          <span>{{ item.title }}</span>
        </button>
      </nav>

      <footer class="flex h-12 flex-none items-center border-t-1 border-t-solid border-t-border py-0 px-2">
        <div class="flex w-full min-w-0 min-h-8 items-center justify-between gap-2">
          <button
            class="desktop-app-sidebar__profile flex min-w-0 min-h-[32px] flex-1 items-center gap-[8px] overflow-hidden border-0 rounded-icon bg-transparent cursor-pointer py-[2px] px-[4px] text-left ui-focus-ring transition-state-colors hover:bg-hover"
            type="button"
            :title="resolvedProfile.userName"
            @click="showAccountDialog = true"
          >
            <DesktopAccountAvatar
              size="compact"
              :avatar-url="resolvedProfile.avatarUrl"
              :name="resolvedProfile.userName"
              :initials="resolvedProfile.initials"
            />
            <strong class="truncate text-app-sidebar-fg text-sidebar-account [font-weight:var(--buddy-sidebar-account-font-weight)]">{{ resolvedProfile.userName }}</strong>
          </button>
          <NPopover
            class="desktop-notification-popover"
            content-class="desktop-notification-popover__content"
            content-style="padding: 0"
            :show="showNotifications"
            trigger="click"
            placement="top-end"
            to=".buddy-app"
            :theme-overrides="notificationPopoverThemeOverrides"
            :width="320"
            @update:show="updateNotificationVisibility"
          >
            <template #trigger>
              <NBadge
                :show="notificationUnseenCount > 0"
                :value="notificationUnseenCount"
                :max="99"
                :offset="[-3, 3]"
                type="info"
              >
                <NButton
                  class="buddy-icon-button desktop-app-sidebar__notification-trigger"
                  :class="{ 'is-open': showNotifications }"
                  quaternary
                  :aria-label="t('desktop.notifications.open')"
                  :aria-expanded="showNotifications"
                >
                  <template #icon>
                    <DesktopIcon :component="Alert20Regular" />
                  </template>
                </NButton>
              </NBadge>
            </template>
            <DesktopNotificationCenter
              v-if="showNotifications"
              :items="notificationItems"
              :language="language"
              :loading="notificationLoading"
              :unseen-count="notificationUnseenCount"
              @mark-all-seen="emit('markAllNotificationsSeen')"
              @open="openNotification"
            />
          </NPopover>
        </div>
      </footer>
    </WorkbenchMountPoint>
    <DesktopAccountDialog
      v-model:show="showAccountDialog"
      :language="language"
      :custom-profile="profileConfig"
      :resolved-profile="resolvedProfile"
      :update-profile="updateProfile"
    />
  </aside>
</template>

<style scoped lang="scss">
.desktop-app-sidebar {
  :deep(.desktop-app-sidebar__notification-trigger.n-button) {
    width: 32px;
    min-width: 32px;
    height: 32px;
    border: 0;
    background: transparent;
    color: var(--buddy-text-primary);
    transition:
      background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
      border-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
      color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

    &:hover {
      border-color: var(--buddy-border-strong);
      background: var(--buddy-state-hover);
      color: var(--buddy-text-strong);
    }

    &.is-open {
      border-color: var(--buddy-accent-border);
      background: var(--buddy-accent-surface-subtle);
      color: var(--buddy-nav-foreground);
    }
  }

  :deep(.n-badge-sup) {
    min-width: 18px;
    padding: 0 5px;
    font-size: 11px;
    font-weight: 500;
  }
}

:global(.desktop-notification-popover.n-popover) {
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 8px;
  box-shadow: var(--buddy-shadow-raised);
}

:global(.desktop-notification-popover__content.n-popover__content) {
  overflow: hidden;
  border-radius: 7px;
  padding: 0;
}
</style>
