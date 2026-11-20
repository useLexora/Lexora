<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowClockwise20Regular, Image20Regular } from '@vicons/fluent'
import { useIntersectionObserver } from '@vueuse/core'
import { NSpin } from 'naive-ui'
import { computed, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ src: string, name: string, label: string, detail: string, language: BuddyLocale, compact?: boolean, expanded?: boolean }>()
const emit = defineEmits<{ preview: [] }>()
const { t } = useBuddyI18n(() => props.language)
const target = useTemplateRef('target')
const visible = shallowRef(false)
const state = shallowRef<'loading' | 'ready' | 'failed'>('loading')
const { isSupported, stop } = useIntersectionObserver(target, (entries) => {
  if (entries.some(entry => entry.isIntersecting)) {
    visible.value = true
    stop()
  }
}, { rootMargin: '160px' })
const requested = computed(() => visible.value || !isSupported.value)
function activate() {
  if (state.value !== 'failed') {
    emit('preview')
    return
  }
  state.value = 'loading'
}
</script>

<template>
  <button
    ref="target" type="button" class="chat-input-material-card__trigger flex flex-1 items-center gap-2 min-w-0 border-0 rounded-micro bg-transparent text-fg text-left cursor-pointer hover:bg-hover ui-focus-ring"
    :class="expanded ? 'p-0' : 'p-[0.4rem]'"
    :aria-label="state === 'failed' ? `${t('desktop.loading.retry')} · ${name}` : t('desktop.imagePreview.open', { name })"
    @click="activate"
  >
    <span class="relative grid flex-none place-items-center overflow-hidden rounded-micro bg-subtle text-muted" :class="compact ? 'h-5 w-5' : expanded ? 'h-28 w-full' : 'h-9 w-9'">
      <img
        v-if="requested && state !== 'failed'" :src="src" :alt="name" decoding="async"
        class="absolute inset-0 h-full w-full object-cover" :class="{ 'opacity-0': state !== 'ready' }"
        @load="state = 'ready'" @error="state = 'failed'"
      >
      <span v-if="state !== 'ready'" class="grid justify-items-center gap-1 text-xs" :role="requested ? 'status' : undefined">
        <DesktopIcon v-if="state === 'failed' || !requested" :component="state === 'failed' ? ArrowClockwise20Regular : Image20Regular" :size="16" />
        <NSpin v-else :size="16" />
        <span v-if="requested" :class="{ 'sr-only': state !== 'failed' || !expanded }">{{ state === 'failed' ? t('desktop.loading.retry') : t('common.loading') }}</span>
      </span>
    </span>
    <span v-if="!expanded" class="grid min-w-0 gap-[3px]">
      <span class="truncate text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">{{ label }}</span>
      <small v-if="!compact && detail" class="text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[1.5]">{{ detail }}</small>
    </span>
  </button>
</template>
