<script setup lang="ts">
import type { FilePreviewErrorKey } from '@/shared/lib/filePreviewError'
import { NButton } from 'naive-ui'
import { computed, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { diagnoseFilePreviewError } from '@/shared/lib/filePreviewError'
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
const errorKey = shallowRef<FilePreviewErrorKey | null>(null)
const failed = computed(() => errorKey.value !== null)
let diagnosis: AbortController | null = null
let disposed = false
const retryKey = shallowRef<string | null>(null)
const requestUrl = computed(() => {
  if (!retryKey.value)
    return props.src
  const url = new URL(props.src)
  url.searchParams.set('v', retryKey.value)
  return url.href
})

function reset() {
  diagnosis?.abort()
  diagnosis = null
  ready.value = false
  errorKey.value = null
}
function retry() {
  player.value?.pause()
  reset()
  retryKey.value = crypto.randomUUID()
}
function isCurrentPlayer(event: Event) {
  return !disposed && event.currentTarget === player.value && player.value?.getAttribute('src') === requestUrl.value
}
function loaded(event: Event) {
  if (isCurrentPlayer(event)) {
    diagnosis?.abort()
    errorKey.value = null
    ready.value = true
  }
}
async function fail(event: Event) {
  if (!isCurrentPlayer(event))
    return
  diagnosis?.abort()
  const request = new AbortController()
  diagnosis = request
  const src = requestUrl.value
  errorKey.value = 'desktop.context.mediaPlaybackFailed'
  const result = await diagnoseFilePreviewError(src, request.signal, 'desktop.context.mediaPlaybackFailed')
  if (!request.signal.aborted && !disposed && src === requestUrl.value)
    errorKey.value = result
}
watch([() => props.src, () => props.kind], () => {
  player.value?.pause()
  retryKey.value = null
  reset()
}, { flush: 'sync' })
watch(() => props.visible, (visible) => {
  if (!visible)
    player.value?.pause()
}, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  diagnosis?.abort()
  player.value?.pause()
})
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
      <span>{{ t(errorKey ?? 'desktop.context.mediaPlaybackFailed') }}</span>
      <NButton size="small" @click="retry">
        {{ t('desktop.context.retry') }}
      </NButton>
    </div>
    <span v-else-if="!ready" class="text-muted text-[13px]" role="status">{{ t('common.loading') }}</span>
  </div>
</template>
