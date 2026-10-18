<script setup lang="ts">
import type { DesktopShellBindings } from './desktopShellBindings'
import { Alert20Regular } from '@vicons/fluent'
import { useEventListener } from '@vueuse/core'
import { NBadge, NButton, NPopover, NTooltip } from 'naive-ui'
import { computed, nextTick, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopNotificationCenter } from '@/modules/notifications/ui'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopAccountAvatar from './DesktopAccountAvatar.vue'
import DesktopAccountDialog from './DesktopAccountDialog.vue'
import { resolveUserProfile } from './userProfile'

type NavigationPanel = 'account' | 'plugins' | 'notifications'

const props = withDefaults(defineProps<{
  bindings: DesktopShellBindings
  presentation: 'full' | 'compact' | 'immersive'
  visible?: boolean
}>(), { visible: true })
defineSlots<{
  default?: (props: { openPanel: NavigationPanel | null, setPanel: (panel: NavigationPanel, show: boolean) => void, closePanel: () => void }) => unknown
}>()
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const openPanel = shallowRef<NavigationPanel | null>(null)
const showAccountDialog = shallowRef(false)
const profile = computed(() => resolveUserProfile(props.bindings.profileConfig.value, props.bindings.appInfo.value))
const iconOnly = computed(() => props.presentation !== 'full')
const controlOrder = computed(() => props.presentation === 'compact'
  ? ['notifications', 'account'] as const
  : ['account', 'notifications'] as const)
const popoverThemeOverrides = { padding: '0' } as const
let panelTrigger: HTMLElement | null = null

function setPanel(panel: NavigationPanel, show: boolean) {
  if (show) {
    panelTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openPanel.value = panel
    if (panel === 'notifications')
      void props.bindings.notifications.load()
  }
  else if (openPanel.value === panel) {
    openPanel.value = null
  }
}
function closePanel() {
  openPanel.value = null
}
function editProfile() {
  closePanel()
  showAccountDialog.value = true
}
watch([() => props.visible, () => props.bindings.pages.current.value], closePanel)
useEventListener(window, 'keydown', (event) => {
  if (event.key !== 'Escape' || !openPanel.value)
    return
  event.stopPropagation()
  closePanel()
  void nextTick(() => {
    if (panelTrigger?.isConnected && props.visible)
      panelTrigger.focus()
  })
}, { capture: true })
</script>

<template>
  <div class="desktop-navigation-controls flex flex-none items-center" :class="presentation === 'compact' ? 'flex-col gap-1 py-2' : presentation === 'immersive' ? 'is-immersive min-h-12 gap-0 px-1' : 'min-h-12 gap-1 px-2'">
    <template v-for="control in controlOrder" :key="control">
      <NPopover v-if="control === 'account'" :show="openPanel === 'account'" :disabled="!iconOnly" trigger="click" placement="top-start" :width="256" to=".buddy-app" @update:show="setPanel('account', $event)">
        <template #trigger>
          <NTooltip class="pointer-events-none" :disabled="!iconOnly || openPanel === 'account'" :placement="presentation === 'compact' ? 'right' : 'top'">
            <template #trigger>
              <button
                class="desktop-app-sidebar__profile flex min-w-0 items-center border-0 rounded-icon bg-transparent cursor-pointer ui-focus-ring transition-state-colors hover:bg-hover"
                :class="iconOnly ? [presentation === 'immersive' ? 'size-7' : 'size-8', 'flex-none justify-center p-0'] : 'min-h-8 flex-1 gap-2 py-[2px] px-1 text-left'"
                type="button"
                :aria-label="iconOnly ? profile.userName : undefined"
                :aria-expanded="iconOnly ? openPanel === 'account' : undefined"
                @click="!iconOnly && editProfile()"
              >
                <DesktopAccountAvatar size="compact" :avatar-url="profile.avatarUrl" :name="profile.userName" :initials="profile.initials" />
                <strong v-if="!iconOnly" class="truncate text-app-sidebar-fg text-sidebar-account [font-weight:var(--buddy-sidebar-account-font-weight)]">{{ profile.userName }}</strong>
              </button>
            </template>
            {{ profile.userName }}
          </NTooltip>
        </template>
        <div class="desktop-navigation-controls__account grid gap-3 p-1">
          <div class="flex min-w-0 items-center gap-3">
            <DesktopAccountAvatar size="medium" :avatar-url="profile.avatarUrl" :name="profile.userName" :initials="profile.initials" />
            <div class="min-w-0">
              <strong class="block truncate text-fg">{{ profile.userName }}</strong>
              <span class="block truncate text-[12px] text-muted">{{ profile.deviceName }}</span>
            </div>
          </div>
          <NButton block secondary @click="editProfile">
            {{ t('desktop.account.dialogTitle') }}
          </NButton>
        </div>
      </NPopover>
      <NPopover
        v-else
        class="desktop-notification-popover" content-class="desktop-notification-popover__content" content-style="padding: 0"
        :show="openPanel === 'notifications'" trigger="click" placement="top-end" to=".buddy-app" :theme-overrides="popoverThemeOverrides" :width="320"
        @update:show="setPanel('notifications', $event)"
      >
        <template #trigger>
          <NTooltip class="pointer-events-none" :disabled="openPanel === 'notifications'" :placement="presentation === 'compact' ? 'right' : 'top'">
            <template #trigger>
              <NBadge :show="bindings.notifications.unseenCount.value > 0" :value="bindings.notifications.unseenCount.value" :max="99" :offset="[-3, 3]" type="info">
                <NButton
                  class="buddy-icon-button desktop-app-sidebar__notification-trigger" :class="{ 'is-open': openPanel === 'notifications' }" quaternary
                  :aria-label="t('desktop.notifications.open')" :aria-expanded="openPanel === 'notifications'"
                >
                  <template #icon>
                    <DesktopIcon :component="Alert20Regular" />
                  </template>
                </NButton>
              </NBadge>
            </template>
            {{ t('desktop.notifications.open') }}
          </NTooltip>
        </template>
        <DesktopNotificationCenter
          v-if="openPanel === 'notifications'" :items="bindings.notifications.items.value" :language="language"
          :loading="bindings.notifications.isLoading.value" :unseen-count="bindings.notifications.unseenCount.value"
          @mark-all-seen="bindings.notifications.markAllSeen"
          @open="notification => { closePanel(); bindings.navigation.openNotification(notification) }"
        />
      </NPopover>
      <slot v-if="control === 'account'" :open-panel="openPanel" :set-panel="setPanel" :close-panel="closePanel" />
    </template>
    <DesktopAccountDialog v-model:show="showAccountDialog" :language="language" :custom-profile="bindings.profileConfig.value" :resolved-profile="profile" :update-profile="bindings.updateProfile" />
  </div>
</template>

<style scoped lang="scss">
.desktop-navigation-controls {
  :deep(.desktop-app-sidebar__notification-trigger.n-button) {
    width: 32px;
    min-width: 32px;
    height: 32px;
    border: 0;
    background: transparent;
    color: var(--buddy-text-primary);
  }

  :deep(.desktop-app-sidebar__notification-trigger.is-open) {
    background: var(--buddy-accent-surface-subtle);
    color: var(--buddy-nav-foreground);
  }

  &.is-immersive :deep(.desktop-app-sidebar__notification-trigger.n-button) {
    width: 28px;
    min-width: 28px;
    height: 28px;
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
