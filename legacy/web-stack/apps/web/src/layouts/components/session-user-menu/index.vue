<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import CopyStateIcon from '@/components/copy-state-icon/CopyStateIcon.vue'
import EntityAvatar from '@/components/entity-avatar'
import SessionAppearancePanel from './appearance-panel'
import SessionNotificationPanel from './notification-panel'
import { useSessionUserMenu } from './useSessionUserMenu'

const props = withDefaults(defineProps<{
  showContextSwitch?: boolean
}>(), {
  showContextSwitch: true,
})

const {
  menuVisible,
  appearanceMenuVisible,
  notificationPanelVisible,
  isLoggingOut,
  appearanceOptions,
  currentUser,
  contextSwitchAction,
  currentAppearance,
  currentAppearanceLabel,
  isSavingAppearance,
  hasLoadedNotificationList,
  isLoadingNotifications,
  isLoadingMoreNotifications,
  isMarkingAllNotificationsRead,
  loadNotificationError,
  activeNotificationFilter,
  notificationItems,
  hasMoreNotifications,
  hasUnreadNotifications,
  unreadNotificationCount,
  copiedUserCode,
  toggleAppearanceMenu,
  toggleNotificationPanel,
  handleCopyUserCode,
  handleNotificationFilterChange,
  handleLoadMoreNotifications,
  handleMarkAllNotificationsRead,
  handleAppearanceSelect,
  switchContext,
  handleLogout,
  getLogoutIconName,
} = useSessionUserMenu({
  showContextSwitch: props.showContextSwitch,
})
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <div class="session-user-menu-entry">
    <ElPopover
      v-model:visible="menuVisible"
      trigger="click"
      placement="top-end"
      :width="220"
      :show-arrow="false"
      teleported
      popper-class="session-user-menu-popper"
    >
      <template #reference>
        <ElBadge
          :value="unreadNotificationCount"
          :max="99"
          :hidden="!hasUnreadNotifications"
          class="session-user-menu-trigger-badge"
        >
          <ElButton
            class="session-user-sidebar-trigger !h-11 !w-11 !min-w-11 !justify-center overflow-hidden !rounded-lg border-none bg-transparent !p-0 text-main shadow-none"
            :aria-label="t('sessionMenu.menu.open')"
          >
            <EntityAvatar
              :name="currentUser.displayName"
              :src="currentUser.avatarUrl"
              :alt="t('common.avatarAlt', { name: currentUser.displayName })"
              :size="30"
              shape="circle"
              kind="user"
              class="session-user-sidebar-trigger__avatar"
            />
          </ElButton>
        </ElBadge>
      </template>

      <div class="session-user-menu flex flex-col gap-0.75">
        <div class="session-user-profile flex items-start gap-1.75 px-0.75 py-0.25">
          <EntityAvatar
            :name="currentUser.displayName"
            :src="currentUser.avatarUrl"
            :alt="t('common.avatarAlt', { name: currentUser.displayName })"
            :size="32"
            shape="circle"
            kind="user"
            class="session-user-profile__avatar"
          />

          <div class="min-w-0 flex-1">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="m-0 truncate text-[13px] font-semibold leading-[1.125rem] text-main">
                  {{ currentUser.displayName }}
                </p>
                <p class="m-0 mt-[0.125rem] truncate text-[11px] leading-[0.9375rem] text-secondary">
                  {{ currentUser.email }}
                </p>
              </div>

              <ElTooltip v-if="contextSwitchAction" :content="contextSwitchAction.label" placement="top">
                <ElButton
                  text
                  class="session-user-profile__context-trigger !ml-0 !h-6 !w-6 !min-w-6 !rounded-md border-none !p-0"
                  :aria-label="contextSwitchAction.label"
                  @click="switchContext"
                >
                  <SvgIcon
                    :category="contextSwitchAction.iconCategory"
                    :icon="contextSwitchAction.icon"
                    size="14px"
                    class="session-user-profile__context-icon"
                  />
                </ElButton>
              </ElTooltip>
            </div>
          </div>
        </div>

        <ElButton
          text
          class="session-user-menu-row session-user-menu-row--code session-menu-button-fill !ml-0 !min-h-[2.375rem] !w-full !justify-start !rounded-lg !px-2.25 !py-0"
          @click="handleCopyUserCode"
        >
          <span class="session-user-menu-row__content flex h-full w-full items-center gap-2.25 text-left">
            <span class="session-user-menu-row__summary min-w-0 flex-1">
              <span class="session-user-menu-row__title block text-[11px] leading-[0.9375rem] text-secondary">{{ t('sessionMenu.accountCode.title') }}</span>
              <strong class="block truncate pt-[0.125rem] text-[12px] leading-4 text-main font-medium">{{ currentUser.userCode }}</strong>
            </span>

            <span class="session-user-menu-row__copy-indicator flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px]">
              <CopyStateIcon :copied="copiedUserCode" />
            </span>
          </span>
        </ElButton>

        <div class="session-user-divider" />

        <div class="session-menu-subpanel-anchor relative">
          <ElButton
            text
            class="session-user-menu-row session-user-menu-row--regular session-menu-button-fill !ml-0 !h-9 !w-full !justify-start !rounded-lg !px-2.25 !py-0 !leading-none"
            :class="{ 'is-active': appearanceMenuVisible }"
            :disabled="isSavingAppearance"
            @click.stop="toggleAppearanceMenu"
          >
            <span class="session-user-menu-row__content flex h-full w-full items-center gap-2.25 text-left">
              <SvgIcon category="ui" icon="contrast" size="14px" class="session-user-menu-row__icon flex h-4 w-4 shrink-0 items-center justify-center text-[14px]" />

              <span class="session-user-menu-row__summary flex min-w-0 flex-1 items-center justify-between gap-2">
                <span class="session-user-menu-row__title overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-none text-main">
                  {{ t('sessionMenu.appearance.title') }}
                </span>

                <span class="session-user-menu-row__current shrink-0 text-[12px] leading-none">
                  {{ currentAppearanceLabel }}
                </span>
              </span>

              <SvgIcon
                category="ui"
                icon="chevron-right"
                size="14px"
                class="session-user-menu-row__chevron shrink-0 text-[14px]"
                :class="appearanceMenuVisible ? 'translate-x-0.5 text-primary' : ''"
              />
            </span>
          </ElButton>

          <SessionAppearancePanel
            v-if="appearanceMenuVisible"
            :current-appearance="currentAppearance"
            :is-saving="isSavingAppearance"
            :options="appearanceOptions"
            @select="handleAppearanceSelect"
          />
        </div>

        <div class="session-menu-subpanel-anchor relative">
          <ElButton
            text
            class="session-user-menu-row session-user-menu-row--regular session-menu-button-fill !ml-0 !h-9 !w-full !justify-start !rounded-lg !px-2.25 !py-0 !leading-none"
            :class="{ 'is-active': notificationPanelVisible }"
            @click.stop="toggleNotificationPanel"
          >
            <span class="session-user-menu-row__content flex h-full w-full items-center gap-2.25 text-left">
              <SvgIcon category="ui" icon="bell" size="14px" class="session-user-menu-row__icon flex h-4 w-4 shrink-0 items-center justify-center text-[14px]" />

              <span class="session-user-menu-row__summary flex min-w-0 flex-1 items-center justify-between gap-2">
                <span class="session-user-menu-row__title overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-none text-main">
                  {{ t('sessionMenu.notifications.title') }}
                </span>

                <span
                  v-if="hasUnreadNotifications"
                  class="session-user-menu-row__badge shrink-0"
                >
                  {{ unreadNotificationCount > 99 ? '99+' : unreadNotificationCount }}
                </span>
                <span v-else class="session-user-menu-row__current shrink-0 text-[12px] leading-none">
                  0
                </span>
              </span>

              <SvgIcon
                category="ui"
                icon="chevron-right"
                size="14px"
                class="session-user-menu-row__chevron shrink-0 text-[14px]"
                :class="notificationPanelVisible ? 'translate-x-0.5 text-primary' : ''"
              />
            </span>
          </ElButton>

          <SessionNotificationPanel
            v-if="notificationPanelVisible"
            :has-loaded-list="hasLoadedNotificationList"
            :is-loading="isLoadingNotifications"
            :is-loading-more="isLoadingMoreNotifications"
            :is-marking-all-read="isMarkingAllNotificationsRead"
            :load-error-message="loadNotificationError"
            :active-filter="activeNotificationFilter"
            :notification-items="notificationItems"
            :unread-count="unreadNotificationCount"
            :has-more="hasMoreNotifications"
            @filter-change="handleNotificationFilterChange"
            @mark-all-read="handleMarkAllNotificationsRead"
            @load-more="handleLoadMoreNotifications"
          />
        </div>

        <div class="session-user-divider" />

        <ElButton
          text
          class="session-user-menu-row session-user-menu-row--regular session-user-logout session-menu-button-fill !ml-0 !h-9 !w-full !justify-start !rounded-lg !px-2.25 !py-0 !leading-none"
          :disabled="isLoggingOut"
          @click="handleLogout"
        >
          <span class="session-user-menu-row__content flex h-full w-full items-center gap-2.25 text-left">
            <SvgIcon
              category="ui"
              :icon="getLogoutIconName()"
              size="14px"
              class="session-user-menu-row__icon flex h-4 w-4 shrink-0 items-center justify-center text-[14px]"
              :class="{ 'animate-spin': isLoggingOut }"
            />
            <span class="text-sm leading-none">{{ isLoggingOut ? t('sessionMenu.logout.loading') : t('sessionMenu.logout.title') }}</span>
          </span>
        </ElButton>
      </div>
    </ElPopover>
  </div>
</template>

<style scoped lang="scss">
:global(.session-user-menu-popper.el-popover) {
  --session-user-menu-inset: 8px;

  position: relative;
  overflow: visible;
  padding: var(--session-user-menu-inset);
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  border-radius: 9px;
  background: var(--brand-bg-surface);
  box-shadow: var(--brand-shadow-hairline);
}

.session-user-menu-entry {
  display: inline-flex;
}

.session-user-menu {
  gap: 0;
}

.session-user-menu-trigger-badge {
  display: inline-flex;

  :deep(.el-badge__content.is-fixed) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 1.125rem;
    height: 1.125rem;
    padding: 0 0.25rem;
    border: 2px solid var(--brand-bg-sidebar);
    border-radius: 999px;
    box-shadow: none;
    line-height: 1;
    transform: translate(56%, -36%);
  }
}

.session-user-profile__avatar {
  background: color-mix(in srgb, var(--brand-fill-light) 70%, var(--brand-bg-surface));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 72%, transparent);
}

.session-user-divider {
  height: 1px;
  margin: 0.375rem calc(0px - var(--session-user-menu-inset));
  background: color-mix(in srgb, var(--brand-border-base) 70%, transparent);
}

.session-menu-button-fill > :deep(span) {
  display: flex;
  width: 100%;
  height: 100%;
}

.session-user-profile {
  margin-bottom: 0.375rem;
  border-radius: 0.5rem;
}

.session-menu-subpanel-anchor {
  & + & {
    margin-top: 0.125rem;
  }
}

.session-user-menu-row--regular {
  font-size: 13px;
}

.session-user-profile__context-trigger {
  --el-button-text-color: var(--brand-text-secondary);
  --el-fill-color-light: color-mix(in srgb, var(--brand-fill-light) 76%, var(--brand-bg-surface));

  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 74%, transparent);
  transition: color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease;

  &:hover {
    --el-button-text-color: var(--brand-primary);
    --el-fill-color-light: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));

    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand-primary) 18%, transparent);
  }
}

.session-user-profile__context-icon {
  color: currentColor;
}

.session-user-menu-row {
  --el-button-text-color: var(--brand-text-primary);
  --el-fill-color-light: transparent;

  transition: background-color 0.18s ease, color 0.18s ease;

  &:hover:not(.is-disabled) {
    --el-fill-color-light: color-mix(in srgb, var(--brand-fill-light) 82%, var(--brand-bg-surface));
  }

  &.is-active {
    --el-button-text-color: var(--brand-text-primary);
    --el-fill-color-light: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));
    color: var(--brand-text-primary);

    .session-user-menu-row__icon,
    .session-user-menu-row__current {
      color: var(--brand-primary);
    }
  }

  &.is-disabled {
    opacity: 1;

    .session-user-menu-row__icon,
    .session-user-menu-row__current,
    .session-user-menu-row__title {
      color: var(--brand-text-tertiary);
    }
  }
}

.session-user-menu-row__icon,
.session-user-menu-row__current,
.session-user-menu-row__chevron {
  color: var(--brand-text-secondary);
}

.session-user-menu-row__chevron {
  transition: transform 0.18s ease, color 0.18s ease;
}

.session-user-menu-row__badge {
  min-width: 1.125rem;
  height: 1.125rem;
  padding-inline: 0.25rem;
  border-radius: 50%;
  background: var(--brand-error);
  color: white;
  font-size: 0.6875rem;
  line-height: 1.125rem;
  text-align: center;
  font-weight: 600;
}

.session-user-menu-row--code {
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  background: color-mix(in srgb, var(--brand-fill-lighter) 28%, var(--brand-bg-surface));

  &:hover {
    border-color: color-mix(in srgb, var(--brand-border-base) 82%, transparent);
    background: color-mix(in srgb, var(--brand-fill-lighter) 42%, var(--brand-bg-surface));
  }
}

.session-user-menu-row__copy-indicator {
  color: var(--brand-text-secondary);
  background: color-mix(in srgb, var(--brand-fill-light) 58%, var(--brand-bg-surface));
  transition: background-color 0.18s ease, color 0.18s ease;
}

.session-user-menu-row--code:hover .session-user-menu-row__copy-indicator {
  color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
}

.session-user-logout:hover {
  --el-fill-color-light: var(--el-color-danger-light-9);
  --el-button-text-color: var(--brand-error);
}

.session-user-sidebar-trigger {
  color: var(--brand-text-primary);
  transition: background-color 0.18s ease;

  &:hover {
    background: color-mix(in srgb, var(--brand-bg-surface) 88%, transparent);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-primary) 18%, transparent);
  }

  > :deep(span) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }
}
</style>
