<script setup lang="ts">
import type { ChatSession } from '../../composables/useChatSessions'
import type { ChatSessionSidebarEmits } from './typing'
import { CHAT_SESSION_CHANNEL } from '@haohaoxue/lexora-contracts/chat/constants'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatSessions } from '../../composables/useChatSessions'
import { useChatSessionSidebar } from '../../composables/useChatSessionSidebar'

type ChatSessionGroupKey = 'direct' | 'connected'

interface ChatSessionGroup {
  key: ChatSessionGroupKey
  title: string
  emptyText: string
  sessions: ChatSession[]
}

const emit = defineEmits<ChatSessionSidebarEmits>()
const { t } = useI18n({ useScope: 'global' })
const { sessions } = useChatSessions()
const {
  confirmBatchDelete,
  enterSelectionMode,
  exitSelectionMode,
  getSessionItemStateClass,
  handleSessionAction,
  handleSessionClick,
  hasSelectedSessions,
  isBatchDeleting,
  isSelectionMode,
  isSessionSelected,
  selectedCount,
} = useChatSessionSidebar()
const collapsedGroupKeys = shallowRef<Set<ChatSessionGroupKey>>(new Set())
const sessionList = computed(() => sessions.value)
const sessionGroups = computed<ChatSessionGroup[]>(() => {
  const directSessions = sessionList.value.filter(session => session.channel === CHAT_SESSION_CHANNEL.DIRECT)
  const connectedSessions = sessionList.value.filter(session => session.channel !== CHAT_SESSION_CHANNEL.DIRECT)

  return [
    {
      key: 'direct',
      title: t('chat.session.directTitle'),
      emptyText: t('chat.session.directEmpty'),
      sessions: directSessions,
    },
    {
      key: 'connected',
      title: t('chat.session.botTitle'),
      emptyText: t('chat.session.botEmpty'),
      sessions: connectedSessions,
    },
  ]
})

function isSessionGroupCollapsed(groupKey: ChatSessionGroupKey) {
  return collapsedGroupKeys.value.has(groupKey)
}

function getSessionGroupChevronIcon(groupKey: ChatSessionGroupKey) {
  return isSessionGroupCollapsed(groupKey) ? 'chevron-right' : 'chevron-down'
}

function toggleSessionGroup(groupKey: ChatSessionGroupKey) {
  const nextCollapsedGroupKeys = new Set(collapsedGroupKeys.value)

  if (nextCollapsedGroupKeys.has(groupKey)) {
    nextCollapsedGroupKeys.delete(groupKey)
  }
  else {
    nextCollapsedGroupKeys.add(groupKey)
  }

  collapsedGroupKeys.value = nextCollapsedGroupKeys
}

function isWeixinBotSession(session: ChatSession) {
  return session.channel === CHAT_SESSION_CHANNEL.WEIXIN_BOT
}
</script>

<template>
  <aside class="chat-session-sidebar flex min-h-0 w-[var(--panel-chat-session-width)] shrink-0 flex-col">
    <div class="chat-session-sidebar__header flex min-h-11 items-center justify-between border-b px-3 py-2">
      <template v-if="isSelectionMode">
        <span class="chat-session-sidebar__selection-count min-w-0 whitespace-nowrap text-sm font-medium text-main">{{ t('chat.session.selectedCount', { count: selectedCount }) }}</span>
        <div class="flex shrink-0 items-center gap-1">
          <ElButton
            text
            size="small"
            class="chat-session-sidebar__header-text-btn h-7 rounded-lg px-2 text-[0.8125rem] text-secondary"
            :class="{ 'chat-session-sidebar__header-text-btn--delete': hasSelectedSessions }"
            :disabled="!hasSelectedSessions"
            :loading="isBatchDeleting"
            @click="confirmBatchDelete"
          >
            {{ t('chat.session.delete') }}
          </ElButton>
          <ElButton
            text
            size="small"
            class="chat-session-sidebar__header-text-btn h-7 rounded-lg px-2 text-[0.8125rem] text-secondary"
            :disabled="isBatchDeleting"
            @click="exitSelectionMode"
          >
            {{ t('chat.session.cancel') }}
          </ElButton>
        </div>
      </template>

      <template v-else>
        <span class="chat-session-sidebar__header-title min-w-0 whitespace-nowrap text-sm font-medium text-main">{{ t('chat.session.title') }}</span>
        <div class="flex shrink-0 items-center gap-1">
          <ElButton
            text
            size="small"
            class="chat-session-sidebar__header-icon-btn h-7 w-7 rounded-lg p-0 text-secondary"
            :title="t('chat.session.multiSelect')"
            @click="enterSelectionMode"
          >
            <SvgIcon category="ui" icon="select-multiple" size="0.95rem" />
          </ElButton>
          <ElButton
            text
            size="small"
            class="chat-session-sidebar__header-icon-btn h-7 w-7 rounded-lg p-0 text-secondary"
            :title="t('chat.session.collapse')"
            @click="emit('collapse')"
          >
            <SvgIcon category="ui" icon="pin-off" size="0.95rem" />
          </ElButton>
        </div>
      </template>
    </div>

    <div class="chat-session-sidebar__scroller min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div v-if="sessionList.length === 0" class="px-3 py-6 text-center text-xs text-secondary-a60">
        {{ t('chat.session.empty') }}
      </div>

      <div v-else class="chat-session-sidebar__sections flex min-h-0 flex-auto flex-col pb-4 pt-2">
        <section
          v-for="group in sessionGroups"
          :key="group.key"
          class="chat-session-sidebar__group flex min-w-0 flex-col"
        >
          <div class="chat-session-sidebar__group-header group flex h-8 items-center gap-1 px-3">
            <button
              type="button"
              class="chat-session-sidebar__group-header-button flex h-full w-full min-w-0 flex-1 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-secondary transition-[background-color,color] duration-200 focus-visible:outline-none"
              :aria-expanded="!isSessionGroupCollapsed(group.key)"
              :aria-controls="`chat-session-sidebar-group-${group.key}`"
              @click="toggleSessionGroup(group.key)"
            >
              <SvgIcon
                category="ui"
                :icon="getSessionGroupChevronIcon(group.key)"
                size="0.875rem"
                class="chat-session-sidebar__group-chevron shrink-0 text-[0.875rem] transition-transform duration-200"
              />
              <span class="chat-session-sidebar__group-title min-w-0 truncate text-sm leading-none">
                {{ group.title }}
              </span>
            </button>
          </div>

          <div
            v-if="!isSessionGroupCollapsed(group.key)"
            :id="`chat-session-sidebar-group-${group.key}`"
            role="group"
            class="chat-session-sidebar__group-body min-w-0 px-3 pb-1 pt-1"
          >
            <ul v-if="group.sessions.length" class="m-0 grid list-none gap-0 p-0">
              <li
                v-for="session in group.sessions"
                :key="session.id"
                class="chat-session-sidebar__item flex min-h-9 min-w-0 items-center rounded-lg border border-transparent text-[13px] leading-5"
                :class="getSessionItemStateClass(session.id)"
              >
                <button
                  type="button"
                  class="chat-session-sidebar__item-main flex h-9 min-w-0 flex-1 items-center gap-1.5 border-none bg-transparent py-0 pl-2 pr-1 text-left text-inherit"
                  @click="handleSessionClick(session.id)"
                >
                  <ElCheckbox
                    v-if="isSelectionMode"
                    :model-value="isSessionSelected(session.id)"
                    class="shrink-0 h-4"
                    @click.stop
                    @change="() => handleSessionClick(session.id)"
                  />
                  <template v-else>
                    <SvgIcon
                      v-if="isWeixinBotSession(session)"
                      category="brand"
                      icon="brand-weixin"
                      size="1rem"
                      class="shrink-0"
                    />
                    <SvgIcon v-else category="ui" icon="chat" size="1rem" class="shrink-0" />
                  </template>
                  <span class="chat-session-sidebar__item-title min-w-0 flex-1 truncate">{{ session.title }}</span>
                </button>

                <ElDropdown
                  v-if="!isSelectionMode"
                  trigger="click"
                  placement="bottom-end"
                  popper-class="chat-session-sidebar__more-popper"
                  @command="command => handleSessionAction(session, command)"
                >
                  <ElButton
                    text
                    size="small"
                    class="chat-session-sidebar__actions-btn mr-1.5 h-5 min-w-5 w-5 shrink-0 rounded-md p-0 opacity-0"
                    :title="t('chat.session.more')"
                    @click.stop
                  >
                    <SvgIcon category="ui" icon="more" size="14px" />
                  </ElButton>

                  <template #dropdown>
                    <ElDropdownMenu class="chat-session-sidebar__menu box-border min-w-0 w-[8.5rem] p-1">
                      <ElDropdownItem command="rename" class="chat-session-sidebar__menu-item min-h-8 px-2 text-main">
                        {{ t('chat.session.rename') }}
                      </ElDropdownItem>
                      <ElDropdownItem
                        command="delete"
                        divided
                        class="chat-session-sidebar__menu-item chat-session-sidebar__menu-item--delete min-h-8 px-2"
                      >
                        {{ t('chat.session.delete') }}
                      </ElDropdownItem>
                    </ElDropdownMenu>
                  </template>
                </ElDropdown>
              </li>
            </ul>

            <div v-else class="chat-session-sidebar__group-empty flex min-h-9 items-center px-6 py-1.5 text-[13px] leading-5 text-secondary">
              {{ group.emptyText }}
            </div>
          </div>
        </section>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.chat-session-sidebar {
  border-right: 1px solid color-mix(in srgb, var(--brand-border-base) 74%, transparent);
  background: var(--brand-bg-sidebar);

  .chat-session-sidebar__header-text-btn,
  .chat-session-sidebar__header-icon-btn {
    &:hover,
    &:focus-visible {
      background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
      color: var(--brand-primary);
    }
  }

  .chat-session-sidebar__header-text-btn {
    &--delete {
      color: var(--brand-error);

      &:hover,
      &:focus-visible {
        color: var(--brand-error);
      }
    }
  }

  .chat-session-sidebar__group {
    & + & {
      margin-top: 0.375rem;
      padding-top: 0.375rem;
      border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 62%, transparent);
    }
  }

  .chat-session-sidebar__group-header {
    background: color-mix(in srgb, var(--brand-fill-light) 74%, var(--brand-bg-sidebar));
    transition: background-color 0.2s ease;

    &:hover,
    &:focus-within {
      background: color-mix(in srgb, var(--brand-fill-light) 54%, var(--brand-bg-surface));
    }
  }

  .chat-session-sidebar__group-header-button,
  .chat-session-sidebar__group-chevron {
    color: var(--brand-text-secondary);
  }

  .chat-session-sidebar__item {
    color: var(--brand-text-secondary);
    transition:
      border-color 0.2s ease,
      background-color 0.2s ease,
      color 0.2s ease,
      box-shadow 0.2s ease;

    &.active {
      border-color: color-mix(in srgb, var(--brand-primary) 20%, transparent);
      background: color-mix(in srgb, var(--brand-primary) 10%, transparent);
      box-shadow:
        0 1px 2px 0 color-mix(in srgb, var(--brand-primary) 6%, transparent),
        0 1px 2px 0 color-mix(in srgb, var(--brand-text-primary) 5%, transparent);
    }

    &.selected {
      border-color: color-mix(in srgb, var(--brand-primary) 18%, transparent);
      background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
    }

    &.idle {
      &:hover,
      &:focus-within {
        border-color: color-mix(in srgb, var(--brand-border-base) 70%, transparent);
        background: var(--brand-fill-lighter);
        color: var(--brand-text-primary);
      }
    }
  }

  .chat-session-sidebar__item-main {
    cursor: pointer;
  }

  .chat-session-sidebar__item.active .chat-session-sidebar__item-main,
  .chat-session-sidebar__item.active .chat-session-sidebar__item-title {
    color: var(--brand-primary);
  }

  .chat-session-sidebar__item.active .chat-session-sidebar__item-title {
    font-weight: 500;
  }

  .chat-session-sidebar__item.active .chat-session-sidebar__actions-btn,
  .chat-session-sidebar__item.selected .chat-session-sidebar__actions-btn {
    opacity: 1;
  }

  .chat-session-sidebar__item.active .chat-session-sidebar__actions-btn {
    color: color-mix(in srgb, var(--brand-primary) 76%, transparent);

    &:hover,
    &:focus-visible {
      color: var(--brand-primary);
      background: transparent;
    }
  }

  .chat-session-sidebar__actions-btn {
    color: var(--brand-text-secondary);
    transition:
      opacity 0.2s ease,
      color 0.2s ease,
      background-color 0.2s ease;

    &:hover,
    &:focus-visible {
      color: var(--brand-primary);
      background: var(--brand-bg-surface-raised);
    }
  }

  .chat-session-sidebar__item:hover .chat-session-sidebar__actions-btn,
  .chat-session-sidebar__item:focus-within .chat-session-sidebar__actions-btn,
  .chat-session-sidebar__actions-btn:focus {
    opacity: 1;
  }
}

:global(.chat-session-sidebar__more-popper .el-popper__arrow) {
  display: none;
}

:global(.chat-session-sidebar__menu-item:not(.is-disabled):hover),
:global(.chat-session-sidebar__menu-item:not(.is-disabled):focus) {
  background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
  color: var(--brand-text-primary);
}

:global(.el-dropdown-menu__item.chat-session-sidebar__menu-item--delete) {
  color: var(--brand-error);
}

:global(.el-dropdown-menu__item.chat-session-sidebar__menu-item--delete:not(.is-disabled):hover),
:global(.el-dropdown-menu__item.chat-session-sidebar__menu-item--delete:not(.is-disabled):focus) {
  background: var(--el-color-danger-light-9);
  color: var(--brand-error);
}
</style>
