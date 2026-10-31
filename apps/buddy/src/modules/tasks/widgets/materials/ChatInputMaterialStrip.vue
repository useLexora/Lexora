<script setup lang="ts">
import type { BuddyInputMaterial } from '@buddy-shared/conversation/buddyInputMaterial'
import type { InputMaterialView } from '../../model/materials/inputMaterialView'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyInputMaterialKey } from '@buddy-shared/conversation/buddyInputMaterial'
import { usePreferredReducedMotion, useTimeoutFn } from '@vueuse/core'
import { NScrollbar } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { scrollWheelHorizontally } from '@/shared/lib/scrollWheelHorizontally'
import BuddyImagePreview from '@/shared/ui/media/BuddyImagePreview.vue'
import ChatInputMaterialCard from './ChatInputMaterialCard.vue'

const props = defineProps<{ materials: readonly InputMaterialView[], language: BuddyLocale, removable?: boolean, disabled?: boolean, compact?: boolean, expanded?: boolean, alignEnd?: boolean, wheelToHorizontal?: boolean }>()
const emit = defineEmits<{ remove: [material: BuddyInputMaterial], retry: [id: string], previewText: [id: string] }>()
const track = useTemplateRef<HTMLElement>('track')
const reducedMotion = usePreferredReducedMotion()
const highlighted = shallowRef<string | null>(null)
const { start } = useTimeoutFn(() => highlighted.value = null, 1400, { immediate: false })
const failedUrls = shallowRef<ReadonlySet<string>>(new Set())
const materials = computed(() => props.materials.map(material => material.kind === 'resource' && material.previewUrl && failedUrls.value.has(material.previewUrl) ? { ...material, previewUrl: null } : material))
const sources = computed(() => materials.value.flatMap(material => material.kind === 'resource' && material.previewUrl ? [material.previewUrl] : []))
const previewOpen = shallowRef(false)
const previewIndex = shallowRef(0)

function highlightMaterial(material: Pick<BuddyInputMaterial, 'kind' | 'id'>) {
  const key = buddyInputMaterialKey(material)
  const card = [...track.value?.querySelectorAll<HTMLElement>('[data-material-key]') ?? []].find(element => element.dataset.materialKey === key)
  if (!card)
    return
  card.scrollIntoView?.({ behavior: reducedMotion.value === 'reduce' ? 'instant' : 'smooth', block: 'nearest', inline: 'nearest' })
  highlighted.value = key
  start()
}

watch(() => props.materials.map(buddyInputMaterialKey), async (keys, previous) => {
  if (!props.removable)
    return
  const added = keys.find(key => !previous.includes(key))
  const material = props.materials.find(material => buddyInputMaterialKey(material) === added)
  if (material) {
    await nextTick()
    highlightMaterial(material)
  }
})

function preview(material: InputMaterialView) {
  if (material.kind !== 'resource' || !material.previewUrl)
    return
  previewIndex.value = sources.value.indexOf(material.previewUrl)
  previewOpen.value = true
}

function handleWheel(event: WheelEvent) {
  if (props.wheelToHorizontal)
    scrollWheelHorizontally(event)
}

defineExpose({ highlightMaterial, highlightResource: (id: string) => highlightMaterial({ kind: 'resource', id }) })
</script>

<template>
  <div v-if="materials.length" class="chat-input-material-strip min-w-0 max-w-full" :class="compact ? 'is-compact' : 'w-full mb-2'" data-quote-exclude>
    <NScrollbar class="chat-input-material-strip__scrollbar" container-class="chat-input-material-strip__scrollport" content-style="width: max-content; min-width: 100%" trigger="hover" x-scrollable @wheel="handleWheel">
      <div ref="track" class="flex flex-nowrap items-start gap-[0.45rem]" :class="{ 'justify-end': alignEnd }">
        <ChatInputMaterialCard
          v-for="material in materials" :id="material.kind === 'resource' ? `buddy-resource-${material.id}` : undefined"
          :key="buddyInputMaterialKey(material)" :material="material" :language="language" :removable="removable" :disabled="disabled" :compact="compact" :expanded="expanded"
          :data-material-key="buddyInputMaterialKey(material)" :data-resource-card="material.kind === 'resource' ? material.id : undefined"
          :data-resource-quote-id="material.kind === 'resource_quote' ? material.id : undefined" :data-quote-id="material.kind === 'message_quote' ? material.id : undefined" :data-session-id="material.kind === 'session' ? material.id : undefined"
          :class="{ 'is-highlighted': highlighted === buddyInputMaterialKey(material), 'resource-quote-card': material.kind === 'resource_quote', 'chat-quote-card': material.kind === 'message_quote', 'chat-session-reference': material.kind === 'session', 'composer-resource-strip__card': removable && material.kind === 'resource', 'buddy-chat-message-content__attachment': !removable && material.kind === 'resource' }"
          @remove="emit('remove', material)" @retry="emit('retry', material.id)" @preview="preview(material)" @preview-text="emit('previewText', material.id)"
          @preview-failed="failedUrls = new Set([...failedUrls, $event])"
        />
      </div>
    </NScrollbar>
    <BuddyImagePreview v-if="sources.length" v-model:show="previewOpen" v-model:current="previewIndex" :language="language" :sources="sources" />
  </div>
</template>

<style scoped lang="scss">
.chat-input-material-strip {
  :deep(.chat-input-material-strip__scrollbar) {
    height: auto;
  }

  :deep(.chat-input-material-strip__scrollport) {
    overscroll-behavior-inline: contain;
  }

  :deep(.is-highlighted) {
    border-color: var(--buddy-focus-ring);
    background: var(--buddy-accent-surface);
    box-shadow: inset 0 0 0 1px var(--buddy-focus-ring);
  }
}
</style>
