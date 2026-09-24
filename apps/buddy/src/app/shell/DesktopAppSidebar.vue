<script setup lang="ts">
import type { DesktopAppInfo, DesktopUserProfileConfig } from '@buddy-electron/shared/desktopApi'
import type { LocalNotification } from '@buddy-shared/notifications/notificationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopView } from '@/shared/navigation/desktopRoutes'
import { Alert20Regular, VehicleShip20Regular } from '@vicons/fluent'
import { NBadge, NButton, NPopover } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import DesktopAccountAvatar from '@/app/shell/DesktopAccountAvatar.vue'
import DesktopAccountDialog from '@/app/shell/DesktopAccountDialog.vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopNotificationCenter } from '@/modules/notifications/ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { resolveUserProfile } from './userProfile'

const props = defineProps<{
  activeExtension: string | null
  appInfo?: DesktopAppInfo | null
  appVersion: string | null
  extensionNavigation: ReadonlyArray<{ id: string, title: string, iconUrl?: string }>
  language: BuddyLocale
  mode: DesktopView
  notificationItems: ReadonlyArray<LocalNotification>
  notificationLoading: boolean
  notificationUnseenCount: number
  profileConfig?: DesktopUserProfileConfig | null
  updateProfile: (patch: Partial<DesktopUserProfileConfig>) => Promise<boolean>
}>()
const emit = defineEmits<{
  markAllNotificationsSeen: []
  navigateAutomations: []
  navigateExtensionPage: [id: string]
  navigateExtensions: []
  navigateSettings: []
  navigateTasks: []
  openNotification: [notification: LocalNotification]
  refreshNotifications: []
}>()
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

function openNotification(notification: LocalNotification) {
  showNotifications.value = false
  emit('openNotification', notification)
}
</script>

<template>
  <aside id="desktop-app-sidebar" class="desktop-app-sidebar">
    <header class="desktop-app-sidebar__header">
      <div class="desktop-app-sidebar__identity">
        <strong>Lexora Buddy</strong>
        <span>{{ versionLabel }}</span>
      </div>
    </header>

    <nav class="desktop-app-sidebar__primary">
      <button
        class="desktop-app-sidebar__nav-item"
        :class="{ 'is-active': mode === 'tasks' }"
        :aria-current="mode === 'tasks' ? 'page' : undefined"
        type="button"
        @click="emit('navigateTasks')"
      >
        <DesktopIcon name="navigationTask" />
        <span>{{ t('desktop.navigation.tasks') }}</span>
      </button>
      <button
        class="desktop-app-sidebar__nav-item"
        :class="{ 'is-active': mode === 'automations' }"
        :aria-current="mode === 'automations' ? 'page' : undefined"
        type="button"
        @click="emit('navigateAutomations')"
      >
        <DesktopIcon name="navigationAutomation" />
        <span>{{ t('desktop.navigation.automations') }}</span>
      </button>
      <button v-for="item in extensionNavigation" :key="item.id" class="desktop-app-sidebar__nav-item" :class="{ 'is-active': mode === 'extension-page' && activeExtension === item.id }" :aria-current="mode === 'extension-page' && activeExtension === item.id ? 'page' : undefined" :data-extension-navigation="item.id" type="button" @click="emit('navigateExtensionPage', item.id)">
        <DesktopPluginIcon :src="item.iconUrl" /><span>{{ item.title }}</span>
      </button>
      <button class="desktop-app-sidebar__nav-item" :class="{ 'is-active': mode === 'extensions' }" :aria-current="mode === 'extensions' ? 'page' : undefined" type="button" @click="emit('navigateExtensions')">
        <DesktopIcon class="desktop-app-sidebar__extension-icon" :component="VehicleShip20Regular" /><span>{{ language === 'en-US' ? 'Plugins' : '插件' }}</span>
      </button>
      <button
        class="desktop-app-sidebar__nav-item"
        :class="{ 'is-active': mode === 'settings' }"
        :aria-current="mode === 'settings' ? 'page' : undefined"
        type="button"
        @click="emit('navigateSettings')"
      >
        <DesktopIcon name="navigationSettings" />
        <span>{{ t('desktop.navigation.settings') }}</span>
      </button>
    </nav>

    <footer class="desktop-app-sidebar__footer">
      <div class="desktop-app-sidebar__account">
        <button
          class="desktop-app-sidebar__profile"
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
          <strong>{{ resolvedProfile.userName }}</strong>
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
  display: flex;
  width: var(--buddy-app-sidebar-width);
  height: 100%;
  min-height: 0;
  flex: none;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-app-sidebar);
}

.desktop-app-sidebar__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0 0.75rem;
}

.desktop-app-sidebar__identity {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.5rem;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    color: var(--buddy-text-strong);
    font-size: var(--buddy-sidebar-header-font-size);
    font-weight: var(--buddy-sidebar-header-font-weight);
  }

  span {
    flex: none;
    color: var(--buddy-text-muted);
    font-size: 11px;
  }
}

.desktop-app-sidebar__primary {
  display: grid;
  min-height: 0;
  flex: 1;
  align-content: start;
  gap: 0.125rem;
  padding: 0.5rem;
  overflow-y: auto;
}

.desktop-app-sidebar__nav-item {
  display: flex;
  width: 100%;
  min-height: 2.25rem;
  align-items: center;
  gap: 0.625rem;
  border: 0;
  border-radius: var(--buddy-icon-button-radius);
  background: transparent;
  color: var(--buddy-text-primary);
  cursor: pointer;
  font-size: var(--buddy-sidebar-item-font-size);
  font-weight: var(--buddy-sidebar-item-font-weight);
  line-height: 20px;
  padding: 0.5rem 0.625rem;
  text-align: left;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &:hover {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:active {
    background: var(--buddy-nav-selected);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  &.is-active {
    background: var(--buddy-nav-hover);
    color: var(--buddy-nav-foreground);
  }

  &.is-active:hover {
    background: var(--buddy-nav-selected);
  }

  &.is-active:active {
    background: var(--buddy-nav-pressed);
  }
}

.desktop-app-sidebar__extension-icon {
  flex: none;
  transform: translateY(-0.025em) scale(1.12);
  transform-origin: center;
}

.desktop-app-sidebar__footer {
  display: flex;
  height: 3rem;
  flex: none;
  align-items: center;
  border-top: 1px solid var(--buddy-border-subtle);
  padding: 0 0.5rem;
}

.desktop-app-sidebar__account {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 2rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.desktop-app-sidebar__profile {
  display: flex;
  min-width: 0;
  min-height: 32px;
  flex: 1;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  border: 0;
  border-radius: var(--buddy-icon-button-radius);
  background: transparent;
  cursor: pointer;
  padding: 2px 4px;
  text-align: left;
  transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &:hover {
    background: var(--buddy-state-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  strong {
    overflow: hidden;
    color: var(--buddy-text-primary);
    font-size: var(--buddy-sidebar-account-font-size);
    font-weight: var(--buddy-sidebar-account-font-weight);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.desktop-app-sidebar :deep(.buddy-icon-button.n-button:hover) {
  background: var(--buddy-state-hover);
}

.desktop-app-sidebar :deep(.desktop-app-sidebar__notification-trigger.n-button) {
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
}

.desktop-app-sidebar :deep(.desktop-app-sidebar__notification-trigger.n-button:hover) {
  border-color: var(--buddy-border-strong);
  color: var(--buddy-text-strong);
}

.desktop-app-sidebar :deep(.desktop-app-sidebar__notification-trigger.n-button.is-open) {
  border-color: var(--buddy-accent-border);
  background: var(--buddy-accent-surface-subtle);
  color: var(--buddy-nav-foreground);
}

.desktop-app-sidebar :deep(.n-badge-sup) {
  min-width: 18px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 500;
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
