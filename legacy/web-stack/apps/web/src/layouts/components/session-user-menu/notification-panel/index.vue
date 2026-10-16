<script setup lang="ts">
import type { NotificationListFilter } from '@haohaoxue/lexora-contracts'
import type { SessionNotificationPanelProps } from '../typing'
import type { TiptapEditorResolveImageSrc } from '@/components/tiptap-editor/content/typing'
import type { SessionNotificationItem } from '@/layouts/components/session-notification-bell/useSessionNotificationBell'
import { NOTIFICATION_LIST_FILTER } from '@haohaoxue/lexora-contracts/notification'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolvePublishedNotificationAssets } from '@/apis/notification'
import EntityAvatar from '@/components/entity-avatar'
import { StandaloneContentEditor } from '@/components/tiptap-editor'

const props = defineProps<SessionNotificationPanelProps>()
const emits = defineEmits<{
  filterChange: [filter: NotificationListFilter]
  markAllRead: []
  loadMore: []
}>()
const { t } = useI18n({ useScope: 'global' })

const ROW_HEIGHT = 148
const OVERSCAN = 4
const scrollContainerRef = shallowRef<HTMLElement | null>(null)
const scrollTop = shallowRef(0)
const pendingLoadMoreItemCount = shallowRef<number | null>(null)
const selectedPlatformNotification = shallowRef<SessionNotificationItem | null>(null)
const imageSrcCache = new Map<string, Promise<string | null>>()
const filterOptions = computed(() => [
  { label: t('sessionMenu.notifications.all'), value: NOTIFICATION_LIST_FILTER.ALL },
  {
    label: props.unreadCount > 0
      ? t('sessionMenu.notifications.unreadWithCount', { count: props.unreadCount })
      : t('sessionMenu.notifications.unread'),
    value: NOTIFICATION_LIST_FILTER.UNREAD,
  },
])
const canLoadMore = computed(() =>
  props.hasMore
  && !props.isLoading
  && !props.isLoadingMore
  && props.notificationItems.length > 0,
)

const virtualStart = computed(() => Math.max(Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN, 0))
const virtualEnd = computed(() => Math.min(virtualStart.value + 12 + OVERSCAN * 2, props.notificationItems.length))
const virtualItems = computed(() =>
  props.notificationItems.slice(virtualStart.value, virtualEnd.value).map((item, offset) => ({
    item,
    index: virtualStart.value + offset,
    top: (virtualStart.value + offset) * ROW_HEIGHT,
  })),
)
const totalHeight = computed(() => props.notificationItems.length * ROW_HEIGHT)

watch(() => [props.activeFilter, props.notificationItems.length] as const, () => {
  pendingLoadMoreItemCount.value = null
  selectedPlatformNotification.value = null
})

watch(() => props.isLoadingMore, (isLoadingMore, wasLoadingMore) => {
  if (!isLoadingMore && wasLoadingMore) {
    pendingLoadMoreItemCount.value = null
  }
})

function handleScroll(event: Event) {
  const target = event.currentTarget as HTMLElement

  scrollTop.value = target.scrollTop

  if (target.scrollTop + target.clientHeight >= target.scrollHeight - ROW_HEIGHT) {
    requestLoadMore()
  }
}

function handleFilterChange(value: string | number | boolean | undefined) {
  if (value !== NOTIFICATION_LIST_FILTER.ALL && value !== NOTIFICATION_LIST_FILTER.UNREAD) {
    return
  }

  scrollTop.value = 0
  scrollContainerRef.value?.scrollTo({ top: 0 })
  emits('filterChange', value)
}

function requestLoadMore() {
  if (!canLoadMore.value || pendingLoadMoreItemCount.value === props.notificationItems.length) {
    return
  }

  pendingLoadMoreItemCount.value = props.notificationItems.length
  emits('loadMore')
}

function openPlatformNotification(item: SessionNotificationItem) {
  selectedPlatformNotification.value = item
}

function handleNotificationItemKeydown(event: KeyboardEvent, item: SessionNotificationItem) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }

  event.preventDefault()
  openPlatformNotification(item)
}

function closePlatformNotification() {
  selectedPlatformNotification.value = null
}

const resolveNotificationImageSrc: TiptapEditorResolveImageSrc = async (assetId) => {
  const cachedSrc = imageSrcCache.get(assetId)

  if (cachedSrc) {
    return cachedSrc
  }

  const pendingSrc = resolvePublishedNotificationAssets({
    assetIds: [assetId],
  }).then((response) => {
    const asset = response.assets.find(item => item.id === assetId)
    return asset?.contentUrl ?? null
  }).catch((error) => {
    imageSrcCache.delete(assetId)
    throw error
  })

  imageSrcCache.set(assetId, pendingSrc)
  return pendingSrc
}
</script>

<template>
  <div class="session-user-menu-subpanel session-notification-panel absolute bottom-0 left-[calc(100%+12px)] z-[8] w-[24rem] p-2">
    <div class="mb-3 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h3 class="m-0 text-sm font-semibold leading-5 text-main">
          {{ t('sessionMenu.notifications.title') }}
        </h3>
      </div>

      <div class="flex shrink-0 items-center gap-1.5">
        <ElTooltip :content="t('sessionMenu.notifications.markAllRead')" effect="dark" placement="top">
          <ElButton
            text
            size="small"
            class="session-notification-panel__mark-read-button !h-7 !w-7 !p-0"
            :disabled="!props.unreadCount || props.isMarkingAllRead"
            :loading="props.isMarkingAllRead"
            :aria-label="t('sessionMenu.notifications.markAllRead')"
            @click="emits('markAllRead')"
          >
            <SvgIcon v-if="!props.isMarkingAllRead" category="ui" icon="check" size="15px" />
          </ElButton>
        </ElTooltip>
      </div>
    </div>

    <ElSegmented
      v-if="!selectedPlatformNotification"
      :model-value="props.activeFilter"
      :options="filterOptions"
      block
      class="session-notification-panel__filters mb-2 w-full"
      @change="handleFilterChange"
    />

    <div v-if="selectedPlatformNotification" class="session-notification-panel__detail min-h-0 flex-1 overflow-hidden rounded-lg border border-base bg-surface">
      <div class="session-notification-panel__detail-header flex items-start gap-3 border-b border-base p-3">
        <ElButton
          text
          class="session-notification-panel__back-button !h-7 !w-7 !p-0"
          :aria-label="t('sessionMenu.notifications.backToList')"
          @click="closePlatformNotification"
        >
          <SvgIcon category="ui" icon="arrow-left" size="15px" />
        </ElButton>

        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <p class="m-0 truncate text-sm font-semibold leading-5 text-main">
              {{ selectedPlatformNotification.senderLabel }}
            </p>
            <time class="shrink-0 text-xs leading-5 text-tertiary">{{ selectedPlatformNotification.receivedLabel }}</time>
          </div>
          <h4 class="m-0 mt-1 text-sm font-semibold leading-5 text-main">
            {{ selectedPlatformNotification.title }}
          </h4>
        </div>
      </div>

      <StandaloneContentEditor
        class="session-notification-panel__detail-editor"
        :content="selectedPlatformNotification.content"
        :editable="false"
        :resolve-image-src="resolveNotificationImageSrc"
      />
    </div>

    <p v-else-if="props.loadErrorMessage" class="session-notification-panel__state m-0 rounded-lg bg-danger-light px-3 py-2 text-xs leading-5 text-danger">
      {{ props.loadErrorMessage }}
    </p>

    <div v-else-if="props.isLoading && !props.hasLoadedList" class="session-notification-panel__state rounded-lg bg-fill-light px-3 py-8 text-center text-sm text-secondary">
      {{ t('sessionMenu.notifications.loading') }}
    </div>

    <div v-else-if="!props.notificationItems.length" class="session-notification-panel__state rounded-lg bg-fill-light px-3 py-8 text-center text-sm text-secondary">
      {{ t('sessionMenu.notifications.none') }}
    </div>

    <div
      v-else
      ref="scrollContainerRef"
      class="session-notification-panel__list relative min-h-0 flex-1 overflow-y-auto rounded-lg border border-base bg-fill-lighter"
      @scroll="handleScroll"
    >
      <div class="relative" :style="{ height: `${totalHeight}px` }">
        <article
          v-for="{ item, index, top } in virtualItems"
          :key="item.id"
          class="session-notification-panel__item absolute left-0 right-0 flex gap-3 border-b border-base bg-surface p-3 is-clickable"
          :class="{
            'is-unread': item.isUnread,
            'is-last': index === props.notificationItems.length - 1,
          }"
          role="button"
          tabindex="0"
          :style="{ height: `${ROW_HEIGHT}px`, transform: `translateY(${top}px)` }"
          @click="openPlatformNotification(item)"
          @keydown="handleNotificationItemKeydown($event, item)"
        >
          <EntityAvatar
            :name="item.senderLabel"
            :src="item.sender.avatarUrl"
            :alt="t('common.avatarAlt', { name: item.senderLabel })"
            :size="36"
            shape="circle"
            kind="workspace"
          />

          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center justify-between gap-3">
              <div class="min-w-0 flex items-center gap-2">
                <span class="truncate text-sm font-semibold leading-5 text-main">{{ item.senderLabel }}</span>
                <span v-if="item.isUnread" class="h-1.75 w-1.75 shrink-0 rounded-full bg-primary" />
              </div>
              <time class="shrink-0 text-xs leading-5 text-tertiary">{{ item.receivedLabel }}</time>
            </div>

            <p class="m-0 mt-1 truncate text-sm font-medium leading-5 text-main">
              {{ item.title }}
            </p>

            <p class="session-notification-panel__content m-0 mt-1 text-xs leading-5 text-secondary">
              {{ item.contentText }}
            </p>

            <div class="mt-2 flex justify-end">
              <ElButton
                text
                size="small"
                class="session-notification-panel__detail-link !h-7 !px-2"
                @click.stop="openPlatformNotification(item)"
              >
                <span class="inline-flex items-center gap-1">
                  {{ t('sessionMenu.notifications.detail') }}
                  <SvgIcon category="ui" icon="chevron-right" size="13px" />
                </span>
              </ElButton>
            </div>
          </div>

          <span class="sr-only">{{ index + 1 }}</span>
        </article>
      </div>

      <div v-if="props.isLoadingMore" class="session-notification-panel__loading-more sticky bottom-0 bg-surface/95 px-3 py-2 text-center text-xs text-secondary">
        {{ t('sessionMenu.notifications.loadingMore') }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.session-user-menu-subpanel {
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  border-radius: 8px;
  background: var(--brand-bg-surface);
  box-shadow: var(--brand-shadow-hairline);
}

.session-notification-panel {
  display: flex;
  flex-direction: column;
  height: min(30rem, calc(100vh - 1.5rem));
  overflow: hidden;

  &__state {
    display: flex;
    flex: 1;
    min-height: 0;
    align-items: center;
    justify-content: center;
  }

  &__mark-read-button {
    --el-button-text-color: var(--brand-text-secondary);
    --el-fill-color-light: color-mix(in srgb, var(--brand-fill-light) 70%, var(--brand-bg-surface));

    border-radius: 0.375rem;

    &:hover:not(.is-disabled) {
      --el-button-text-color: var(--brand-primary);
      --el-fill-color-light: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));
    }
  }

  &__item {
    transition: background-color 0.16s ease;

    &.is-clickable {
      cursor: pointer;
    }

    &.is-clickable:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--brand-primary) 32%, transparent);
      outline-offset: -3px;
    }

    &.is-clickable:hover {
      background: color-mix(in srgb, var(--brand-primary) 4%, var(--brand-bg-surface));
    }

    &::after {
      position: absolute;
      right: 0.75rem;
      bottom: 0;
      left: 0;
      height: 1px;
      background: var(--brand-fill-light);
      content: '';
    }

    &.is-unread {
      background: color-mix(in srgb, var(--brand-primary) 5%, var(--brand-bg-surface));
    }

    &.is-last::after {
      display: none;
    }
  }

  &__content {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  &__back-button {
    --el-button-text-color: var(--brand-text-secondary);
    --el-fill-color-light: color-mix(in srgb, var(--brand-fill-light) 76%, var(--brand-bg-surface));

    border-radius: 0.375rem;

    &:hover:not(.is-disabled) {
      --el-button-text-color: var(--brand-primary);
    }
  }

  &__detail-link {
    --el-button-text-color: var(--brand-primary);
    --el-fill-color-light: color-mix(in srgb, var(--brand-primary) 7%, var(--brand-bg-surface));

    border-radius: 0.375rem;
    font-weight: 600;

    &:hover:not(.is-disabled) {
      --el-button-text-color: var(--brand-primary);
      --el-fill-color-light: color-mix(in srgb, var(--brand-primary) 11%, var(--brand-bg-surface));
    }
  }

  &__detail-editor {
    height: calc(100% - 4.625rem);

    :deep(.standalone-content-editor) {
      display: flex;
      height: 100%;
      min-height: 0;
      flex-direction: column;
    }

    :deep(.standalone-content-editor__surface),
    :deep(.tiptap-editor) {
      min-height: 0;
      flex: 1 1 0%;
    }

    :deep(.tiptap-editor__content) {
      min-height: 0;
      overflow: auto;
    }

    :deep(.ProseMirror) {
      min-height: 100%;
      padding: 0.875rem 1rem 1rem;
    }
  }
}
</style>
