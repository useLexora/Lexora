<script setup lang="ts">
import type { InputMaterialView } from '../../model/materials/inputMaterialView'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Chat20Regular, Dismiss16Regular, Globe20Regular, TextQuote20Regular } from '@vicons/fluent'
import { NButton, NPopover, NSpin } from 'naive-ui'
import { computed, inject, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { inputMaterialLabel, inputMaterialText } from '../../model/materials/inputMaterialView'
import { chatQuoteNavigationKey } from '../quotes/chatQuoteContext'
import { sessionReferenceNavigationKey } from '../references/sessionReferenceNavigation'

const props = defineProps<{
  material: InputMaterialView
  language: BuddyLocale
  removable?: boolean
  disabled?: boolean
  compact?: boolean
  expanded?: boolean
}>()
const emit = defineEmits<{ remove: [], retry: [], preview: [], previewText: [], previewFailed: [url: string] }>()
const { t } = useBuddyI18n(() => props.language)
const references = useSelectionReferences()
const locateMessage = inject(chatQuoteNavigationKey, null)
const locateSession = inject(sessionReferenceNavigationKey, null)
const locating = shallowRef(false)
const unavailable = shallowRef(false)
const label = computed(() => props.material.kind === 'resource' ? props.material.imageLabel ?? props.material.resource.name : inputMaterialLabel(props.material, props.language))
const detail = computed(() => {
  const material = props.material
  if (material.kind !== 'resource')
    return inputMaterialText(material)
  if (material.resource.state !== 'ready')
    return t(material.resource.state === 'importing' ? 'desktop.chat.importingAttachment' : material.canRetry ? 'desktop.chat.failedAttachment' : 'desktop.chat.attachmentSourceUnavailable')
  return material.textLineCount !== undefined ? t('desktop.chat.pastedTextLines', { count: material.textLineCount }) : material.resource.kind === 'directory' ? material.resource.path ?? '' : formatFileSize(material.resource.sizeBytes)
})
const sourcePath = computed(() => {
  const material = props.material
  if (material.kind === 'resource')
    return material.resource.path
  if (material.kind !== 'resource_quote')
    return undefined
  const quote = material.quote
  return 'element' in quote ? quote.source.url : quote.source.kind === 'file' ? quote.source.file.path : quote.source.kind === 'artifact' ? quote.source.path : undefined
})
const canLocate = computed(() => props.material.kind === 'resource_quote' ? !!references : props.material.kind === 'message_quote' ? !!locateMessage : props.material.kind === 'session' && !!locateSession)

async function locate() {
  if (locating.value)
    return
  locating.value = true
  unavailable.value = false
  try {
    const material = props.material
    if (material.kind === 'resource_quote')
      unavailable.value = !await references?.locate(material.quote)
    else if (material.kind === 'message_quote')
      await locateMessage?.(material.quote)
    else if (material.kind === 'session')
      await locateSession?.(material.id)
  }
  finally {
    locating.value = false
  }
}
</script>

<template>
  <div class="chat-input-material-card flex flex-none items-start min-w-0 border-1 border-solid border-border rounded-micro bg-raised" :class="{ 'is-compact': compact, 'is-preview': expanded && !compact && material.kind === 'resource' && !!material.previewUrl, 'is-failed': material.kind === 'resource' && material.resource.state === 'failed' }">
    <NPopover trigger="click" placement="top-start" :show-arrow="false" :disabled="material.kind === 'resource' && !!(material.previewUrl || material.textPreview)">
      <template #trigger>
        <button type="button" class="chat-input-material-card__trigger chat-reference-card__link flex flex-1 items-center gap-2 min-w-0 border-0 rounded-micro bg-transparent p-[0.4rem] text-fg text-left cursor-pointer hover:bg-hover ui-focus-ring" @click="material.kind === 'resource' && (material.previewUrl ? emit('preview') : material.textPreview && emit('previewText'))">
          <NSpin v-if="material.kind === 'resource' && material.resource.state === 'importing'" :size="20" />
          <img v-else-if="material.kind === 'resource' && material.previewUrl" class="flex-none rounded-micro object-cover" :src="material.previewUrl" :alt="material.resource.name" :width="compact ? 20 : 36" :height="compact ? 20 : 36" @error="emit('previewFailed', material.previewUrl)">
          <FolderIcon v-else-if="material.kind === 'resource' && material.resource.kind === 'directory'" class="flex-none w-6 h-6" />
          <FileIcon v-else-if="material.kind === 'resource'" :name="material.resource.name" :size="compact ? 'small' : 'medium'" />
          <FileIcon v-else-if="material.kind === 'resource_quote' && (material.quote.source.kind === 'file' || material.quote.source.kind === 'artifact')" :name="material.quote.source.title" :size="compact ? 'small' : 'medium'" />
          <DesktopIcon v-else :component="material.kind === 'session' ? Chat20Regular : material.kind === 'resource_quote' && 'element' in material.quote ? Globe20Regular : TextQuote20Regular" class="flex-none text-muted" />
          <span class="grid min-w-0 gap-[3px]">
            <span class="truncate text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">{{ label }}</span>
            <small v-if="!compact && detail" class="chat-input-material-card__detail text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[1.5]">{{ detail }}</small>
          </span>
        </button>
      </template>
      <section class="resource-quote-preview w-[min(400px,_calc(100vw_-_48px))] max-w-full text-fg">
        <header class="font-600 text-[13px] [overflow-wrap:anywhere]">
          {{ label }}
        </header>
        <p v-if="sourcePath" class="my-2 text-muted text-[12px] [overflow-wrap:anywhere]">
          {{ sourcePath }}
        </p>
        <pre v-if="material.kind === 'resource_quote' || material.kind === 'message_quote'" class="max-h-[min(320px,_45vh)] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-[inherit] border-y border-y-solid border-y-border py-3 my-3 text-[length:var(--buddy-chat-user-font-size)] leading-[var(--buddy-chat-user-line-height)] select-text">{{ material.quote.text }}</pre>
        <p v-else class="my-2 text-muted text-[12px] [overflow-wrap:anywhere]">
          {{ detail }}
        </p>
        <p v-if="unavailable" class="text-muted text-[12px]">
          {{ t('desktop.chat.resourceQuoteSourceUnavailable') }}
        </p>
        <NButton v-if="canLocate" size="small" secondary :loading="locating" @click="locate">
          {{ t('desktop.chat.resourceQuoteLocate') }}
        </NButton>
        <NButton v-if="material.kind === 'resource' && material.previewUrl" size="small" secondary @click="emit('preview')">
          {{ t('desktop.imagePreview.open', { name: material.resource.name }) }}
        </NButton>
        <NButton v-else-if="material.kind === 'resource' && material.textPreview" size="small" secondary @click="emit('previewText')">
          {{ t('desktop.chat.pastedTextPreview', { name: material.resource.name }) }}
        </NButton>
      </section>
    </NPopover>
    <NButton v-if="material.kind === 'resource' && material.resource.state === 'failed' && material.canRetry" class="self-center" text :disabled="disabled" size="tiny" @click="emit('retry')">
      {{ t('desktop.chat.retryAttachment') }}
    </NButton>
    <NButton v-if="removable" class="buddy-icon-button flex-none mt-1 mr-1" quaternary size="tiny" :disabled="disabled" :aria-label="t(material.kind === 'resource' ? 'desktop.chat.removeAttachment' : material.kind === 'session' ? 'desktop.chat.removeSessionReference' : 'desktop.chat.removeQuote')" @click="emit('remove')">
      <template #icon>
        <DesktopIcon :component="Dismiss16Regular" />
      </template>
    </NButton>
  </div>
</template>

<style scoped lang="scss">
.chat-input-material-card {
  width: 180px;
  max-width: 100%;

  &.is-compact {
    width: auto;
    max-width: 140px;
  }

  &.is-preview {
    .chat-input-material-card__trigger {
      flex-direction: column;
      align-items: stretch;
    }

    img {
      width: 100%;
      height: 112px;
    }
  }

  &.is-failed {
    border-color: var(--buddy-status-warning-text);
  }

  &__detail {
    display: -webkit-box;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}
</style>
