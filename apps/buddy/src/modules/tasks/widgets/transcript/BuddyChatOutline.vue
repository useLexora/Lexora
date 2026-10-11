<script setup lang="ts">
import type { DesktopChatOutlinePosition } from '@buddy-electron/shared/desktopApi'
import type { VirtualListInst } from 'naive-ui'

import type { ChatOutlineItem } from '../../model/transcript/chatOutline'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Keyboard20Regular, Wand20Regular } from '@vicons/fluent'
import { NVirtualList } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'

import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  activeMessageId: string | null
  isLoading: boolean
  items: ReadonlyArray<ChatOutlineItem>
  language: BuddyLocale
  position: DesktopChatOutlinePosition
}>()

const emit = defineEmits<{
  prepare: []
  select: [messageId: string]
  scrollTranscript: [deltaY: number]
}>()

const MAX_RAIL_ITEM_COUNT = 48
const OUTLINE_ROW_HEIGHT = 32

const { t } = useBuddyI18n(() => props.language)
const root = useTemplateRef<HTMLElement>('root')
const list = useTemplateRef<VirtualListInst>('list')
const isExpanded = shallowRef(false)
const scrollTop = shallowRef(0)
const virtualItems = computed(() => [...props.items])
const itemIndexes = computed(() => new Map(props.items.map((item, index) => [item.messageId, index])))
const railItems = computed(() => {
  if (props.items.length <= MAX_RAIL_ITEM_COUNT)
    return props.items

  const indexes = Array.from({ length: MAX_RAIL_ITEM_COUNT }, (_, index) => (
    Math.round(index * (props.items.length - 1) / (MAX_RAIL_ITEM_COUNT - 1))
  ))
  const activeIndex = itemIndexes.value.get(props.activeMessageId ?? '') ?? -1
  if (activeIndex >= 0 && !indexes.includes(activeIndex)) {
    let nearestIndex = 0
    for (let index = 1; index < indexes.length; index += 1) {
      if (Math.abs(indexes[index] - activeIndex) < Math.abs(indexes[nearestIndex] - activeIndex))
        nearestIndex = index
    }
    indexes[nearestIndex] = activeIndex
  }

  return [...new Set(indexes)]
    .sort((left, right) => left - right)
    .map(index => props.items[index])
})

watch(list, async (value) => {
  if (!value)
    return
  await nextTick()
  value.scrollTo({ top: scrollTop.value })
}, { flush: 'post' })

function handleListScroll(event: Event) {
  if (event.target instanceof HTMLElement)
    scrollTop.value = event.target.scrollTop
}

async function handleListKeydown(event: KeyboardEvent, index: number) {
  const scrollport = root.value?.querySelector<HTMLElement>('.v-vl')
  const pageSize = Math.max(1, Math.floor((scrollport?.clientHeight ?? OUTLINE_ROW_HEIGHT) / OUTLINE_ROW_HEIGHT))
  const targets: Record<string, number> = {
    ArrowDown: index + 1,
    ArrowUp: index - 1,
    End: props.items.length - 1,
    Home: 0,
    PageDown: index + pageSize,
    PageUp: index - pageSize,
  }
  const target = targets[event.key]
  if (target === undefined || event.altKey || event.ctrlKey || event.metaKey)
    return
  event.preventDefault()
  const nextIndex = Math.max(0, Math.min(props.items.length - 1, target))
  root.value?.focus({ preventScroll: true })
  list.value?.scrollTo({ index: nextIndex })
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await nextTick()
  if (isExpanded.value)
    root.value?.querySelector<HTMLButtonElement>(`[data-outline-index="${nextIndex}"]`)?.focus({ preventScroll: true })
}

function expand() {
  isExpanded.value = true
  emit('prepare')
}

function collapse() {
  isExpanded.value = false
}

function handleFocusOut(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget))
    isExpanded.value = false
}

function roleLabel(item: ChatOutlineItem): string {
  return t(item.kind === 'input' ? 'desktop.chat.outlineInput' : 'desktop.chat.outlineOutput')
}

function itemText(item: ChatOutlineItem): string {
  return item.attachmentOnly ? t('desktop.chat.outlineAttachment') : item.text
}

function itemAriaLabel(item: ChatOutlineItem): string {
  return t('desktop.chat.outlineNavigate', {
    role: roleLabel(item),
    text: itemText(item),
  })
}

function roleIcon(item: ChatOutlineItem) {
  return item.kind === 'input' ? Keyboard20Regular : Wand20Regular
}

function handleRailWheel(event: WheelEvent) {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
    ? event.deltaY
    : event.deltaX
  const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? window.innerHeight
      : 1
  emit('scrollTranscript', delta * multiplier)
}

function select(messageId: string) {
  collapse()
  emit('select', messageId)
}
</script>

<template>
  <aside
    v-if="items.length"
    ref="root"
    class="buddy-chat-outline absolute z-4 top-4 right-[0.875rem] w-[14px] h-[calc(100%_-_2rem)] pointer-events-none"
    :class="{ 'is-left': position.endsWith('left'), 'is-center': position.startsWith('center'), 'is-bottom': position.startsWith('bottom') }"
    tabindex="-1"
    :aria-label="t('desktop.chat.outline')"
    @focusin="expand"
    @focusout="handleFocusOut"
    @mouseleave="collapse"
  >
    <section
      v-if="isExpanded"
      class="buddy-chat-outline__panel absolute top-0 right-[calc(100%_+_0.5rem)] box-border flex w-60 h-[calc(var(--buddy-outline-content-height)_+_1.25rem_+_2px)] max-h-full flex-col gap-1 border-1 border-solid border-border rounded-micro bg-raised shadow-overlay p-[0.625rem] pointer-events-auto"
      :style="{ '--buddy-outline-content-height': `${items.length * OUTLINE_ROW_HEIGHT}px` }"
    >
      <div v-if="isLoading" class="text-muted text-[0.68rem] leading-[1.5] py-[0.125rem] px-1" role="status">
        {{ t('desktop.chat.outlineLoading') }}
      </div>
      <NVirtualList
        ref="list"
        class="buddy-chat-outline__list"
        :items="virtualItems"
        :item-size="OUTLINE_ROW_HEIGHT"
        :default-scroll-index="Math.floor(scrollTop / OUTLINE_ROW_HEIGHT)"
        key-field="messageId"
        visible-items-tag="ol"
        :visible-items-props="{ class: 'buddy-chat-outline__visible-items' }"
        @scroll="handleListScroll"
      >
        <template #default="{ item, index }">
          <li
            :key="item.messageId"
            class="buddy-chat-outline__item box-border h-[32px] min-w-0 rounded-micro text-fg py-[2px]"
            :class="[`is-${item.kind}`, { 'is-active': item.messageId === activeMessageId }]"
            :aria-posinset="index + 1"
            :aria-setsize="items.length"
          >
            <button
              type="button"
              class="buddy-chat-outline__item-button box-border grid w-full h-full min-w-0 grid-cols-[1rem_minmax(0,_1fr)] items-center gap-[0.375rem] border-0 bg-transparent text-inherit cursor-pointer py-0 px-2 text-left ui-focus-ring"
              :data-outline-index="index"
              :aria-label="itemAriaLabel(item)"
              :aria-current="item.messageId === activeMessageId ? 'location' : undefined"
              @click="select(item.messageId)"
              @keydown="handleListKeydown($event, index)"
            >
              <DesktopIcon
                class="buddy-chat-outline__role-icon"
                :component="roleIcon(item)"
                aria-hidden="true"
              />
              <span class="overflow-hidden text-[0.75rem] leading-[1.4] text-ellipsis whitespace-nowrap">{{ itemText(item) }}</span>
            </button>
          </li>
        </template>
      </NVirtualList>
    </section>

    <ol class="buddy-chat-outline__rail box-border flex w-full h-full flex-col items-end gap-[1px] m-0 overflow-hidden py-[0.125rem] px-0" @wheel.prevent="handleRailWheel">
      <li
        v-for="item in railItems"
        :key="item.messageId"
        class="buddy-chat-outline__indicator flex w-full max-h-[6px] justify-end"
        :class="{ 'is-active': item.messageId === activeMessageId }"
      >
        <button
          type="button"
          class="buddy-chat-outline__indicator-button flex w-full items-center justify-end border-0 bg-transparent cursor-pointer p-0 pointer-events-auto focus-visible:outline-0"
          :aria-label="itemAriaLabel(item)"
          :aria-current="item.messageId === activeMessageId ? 'location' : undefined"
          @click="select(item.messageId)"
          @mouseenter="expand"
        >
          <span class="buddy-chat-outline__indicator-line block w-[10px] h-[min(2px,_100%)] rounded-[1px] bg-border-strong" />
        </button>
      </li>
    </ol>
  </aside>
</template>

<style scoped lang="scss">
.buddy-chat-outline {
  &.is-left {
    right: auto;
    left: 0.875rem;

    .buddy-chat-outline__panel {
      right: auto;
      left: calc(100% + 0.5rem);

      &::after {
        right: auto;
        left: -0.5rem;
      }
    }

    .buddy-chat-outline__indicator-button {
      justify-content: flex-start;
    }
  }

  &.is-center {
    .buddy-chat-outline__rail {
      justify-content: center;
    }

    .buddy-chat-outline__panel {
      top: 50%;
      transform: translateY(-50%);
    }
  }

  &.is-bottom {
    .buddy-chat-outline__rail {
      justify-content: flex-end;
    }

    .buddy-chat-outline__panel {
      top: auto;
      bottom: 0;
    }
  }
}

.buddy-chat-outline__panel {
  &::after {
    position: absolute;
    top: 0;
    right: -0.5rem;
    width: 0.5rem;
    height: 100%;
    content: '';
  }
}

.buddy-chat-outline__list {
  min-height: 0;
  flex: 1;

  :deep(.v-vl) {
    overscroll-behavior: contain;
  }
}

:deep(.buddy-chat-outline__visible-items) {
  margin: 0;
  padding: 0;
  list-style: none;
}

.buddy-chat-outline__item {
  &.is-active .buddy-chat-outline__item-button {
    background: var(--buddy-accent-surface);
    color: var(--buddy-accent-on-surface);
  }

  &:not(.is-active) .buddy-chat-outline__item-button:hover {
    background: var(--buddy-state-hover);
  }
}

.buddy-chat-outline__item-button {
  border-radius: inherit
}

.buddy-chat-outline__role-icon {
  color: var(--buddy-text-muted);
  font-size: 1rem;
}

.buddy-chat-outline__item.is-active .buddy-chat-outline__role-icon {
  color: var(--buddy-accent-text);
}

.buddy-chat-outline__rail {
  list-style: none;
}

.buddy-chat-outline__indicator {
  flex: 1 1 6px;
}

.buddy-chat-outline__indicator.is-active .buddy-chat-outline__indicator-line,
.buddy-chat-outline__indicator-button:focus-visible .buddy-chat-outline__indicator-line {
  width: 14px;
  background: var(--buddy-accent-solid);
}
</style>
