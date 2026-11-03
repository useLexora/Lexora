<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular } from '@vicons/fluent'
import { computed, nextTick, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useChatUserBubbleOverflow } from './useChatUserBubbleOverflow'

const props = defineProps<{ language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const root = useTemplateRef<HTMLElement>('root')
const body = useTemplateRef<HTMLElement>('body')
const bodyId = useId()
const { expanded, overflowing } = useChatUserBubbleOverflow(body)
const toggleLabel = computed(() => t(expanded.value ? 'desktop.chat.collapseUserMessage' : 'desktop.chat.expandUserMessage'))

async function toggle() {
  const scrollport = root.value?.closest<HTMLElement>('.buddy-chat-transcript-viewport__scrollport')
  const previousTop = root.value?.getBoundingClientRect().top ?? 0
  expanded.value = !expanded.value
  if (expanded.value || !scrollport)
    return
  await nextTick()
  if (!root.value?.isConnected || !scrollport.isConnected)
    return
  const viewportTop = scrollport.getBoundingClientRect().top
  const targetTop = previousTop < viewportTop ? viewportTop + 8 : previousTop
  scrollport.scrollTop += root.value.getBoundingClientRect().top - targetTop
}

function revealFocusedReference() {
  if (overflowing.value)
    expanded.value = true
}
</script>

<template>
  <div ref="root" class="buddy-chat-user-bubble">
    <div
      :id="bodyId"
      ref="body"
      class="buddy-chat-user-bubble__body"
      :class="{ 'is-collapsed': !expanded }"
      @focusin="revealFocusedReference"
    >
      <slot />
    </div>
    <div v-if="overflowing" class="buddy-chat-user-bubble__footer" data-quote-exclude>
      <button
        class="buddy-chat-user-bubble__toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        :aria-label="toggleLabel"
        :title="toggleLabel"
        @click="toggle"
      >
        <DesktopIcon
          class="buddy-chat-user-bubble__chevron"
          :component="ChevronDown16Regular"
          :size="16"
          :class="{ 'is-expanded': expanded }"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.buddy-chat-user-bubble__body {
  min-width: 0;
  overflow-wrap: anywhere;
}

.buddy-chat-user-bubble__body.is-collapsed,
.buddy-chat-user-bubble__body.is-measuring {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
}

.buddy-chat-user-bubble__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.15rem;
  white-space: normal;
}

.buddy-chat-user-bubble__toggle {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: pointer;
  padding: 0;
}

.buddy-chat-user-bubble__toggle:hover {
  background: var(--buddy-accent-surface-subtle);
  color: var(--buddy-text-primary);
}

.buddy-chat-user-bubble__toggle:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 1px;
}

.buddy-chat-user-bubble__chevron {
  transition: transform 120ms ease-out;
}

.buddy-chat-user-bubble__toggle .is-expanded {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-user-bubble__chevron {
    transition: none;
  }
}
</style>
