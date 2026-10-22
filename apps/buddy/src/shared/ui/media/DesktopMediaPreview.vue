<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'

const props = withDefaults(defineProps<{
  kind: 'audio' | 'video'
  src: string
  name: string
  language: 'zh-CN' | 'en-US'
  visible?: boolean
}>(), { visible: true })
const { t } = useBuddyI18n(() => props.language)
const { isDark } = useDesktopUi()
const player = useTemplateRef<HTMLMediaElement>('player')
const ready = shallowRef(false)
const failed = shallowRef(false)
const retryKey = shallowRef<string | null>(null)
const requestUrl = computed(() => {
  if (!retryKey.value)
    return props.src
  const url = new URL(props.src)
  url.searchParams.set('v', retryKey.value)
  return url.href
})

function reset() {
  ready.value = false
  failed.value = false
}
function retry() {
  player.value?.pause()
  reset()
  retryKey.value = crypto.randomUUID()
}
function loaded(event: Event) {
  if (event.currentTarget === player.value)
    ready.value = true
}
function fail(event: Event) {
  if (event.currentTarget === player.value)
    failed.value = true
}
watch(() => props.src, () => {
  player.value?.pause()
  retryKey.value = null
  reset()
}, { flush: 'sync' })
watch(() => props.visible, (visible) => {
  if (!visible)
    player.value?.pause()
}, { flush: 'sync' })
onBeforeUnmount(() => player.value?.pause())
</script>

<template>
  <div class="desktop-media-preview flex flex-1 flex-col items-center justify-center gap-3 min-w-0 min-h-0 overflow-hidden p-4 bg-surface" :style="{ colorScheme: isDark ? 'dark' : 'light' }">
    <component
      :is="kind"
      v-show="!failed"
      :key="requestUrl"
      ref="player"
      :src="requestUrl"
      :aria-label="name"
      controls
      playsinline
      preload="metadata"
      class="desktop-media-preview__player min-h-0 max-h-full max-w-full"
      :class="kind === 'audio' ? 'w-full max-w-[640px] shrink-0' : 'object-contain'"
      @loadedmetadata="loaded"
      @error="fail"
    />
    <div v-if="failed" class="flex flex-col items-center gap-3 max-w-96 text-center text-muted text-[13px]" role="alert">
      <span>{{ t('desktop.context.mediaPlaybackFailed') }}</span>
      <NButton size="small" @click="retry">
        {{ t('desktop.context.retry') }}
      </NButton>
    </div>
    <span v-else-if="!ready" class="text-muted text-[13px]" role="status">{{ t('common.loading') }}</span>
  </div>
</template>
