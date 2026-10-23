<script setup lang="ts">
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyFileQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { resolveBuiltinFileOpening } from '@buddy-shared/files/fileOpening'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import ResourceSelectionQuoteMenu from '@/shared/ui/selection/ResourceSelectionQuoteMenu.vue'
import { useResourceQuoteReveal } from '@/shared/ui/selection/useResourceQuoteReveal'
import { useResourceSelectionQuote } from '@/shared/ui/selection/useResourceSelectionQuote'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

import { fileOpeningHandler } from '../model/fileOpeningHandlers'
import { useFileOpening } from '../state/fileOpeningContext'
import { filePreviewRenderer } from './filePreviewRenderers'

const props = withDefaults(defineProps<{ view: WorkbenchView, files: LocalChatApi['spaces'], language: 'zh-CN' | 'en-US', writeClipboardText: (text: string) => Promise<void>, toolbarTarget?: HTMLElement | null, visible?: boolean }>(), { visible: true })
const { labels, controller } = useWorkbench()
const preview = shallowRef<LocalSpaceFilePreview | null>(null)
const failed = shallowRef(false)
const missing = shallowRef(false)
const opening = useFileOpening()
const target = computed(() => spaceFileTargetSchema.strip().parse(props.view.resource.data))
const provider = computed(() => (opening?.resolve(props.view.title, 'inline') ?? resolveBuiltinFileOpening(props.view.title, 'inline')).provider)
const previewRenderer = computed(() => filePreviewRenderer({ provider: provider.value, ownerId: props.view.id, target: target.value, source: 'file', resourceReady: true, text: preview.value?.text ?? undefined, name: props.view.title, visible: props.visible, language: props.language }))
const modes = computed(() => fileDocumentModes({ preview: !!fileOpeningHandler(provider.value)?.preview, source: preview.value?.kind === 'text', edit: false }))
const mode = computed({ get: () => resolveFileDocumentMode(props.view.state.mode, modes.value), set: value => controller.updateView(props.view.id, { state: { ...props.view.state, mode: value } }) })
const quoteSource = computed<BuddyFileQuote['source']>(() => ({
  kind: 'file',
  title: props.view.title,
  file: spaceFileTargetSchema.strip().parse(props.view.resource.data),
  format: mode.value === 'preview' ? 'markdown' : 'source',
}))
const identity = computed(() => {
  const { scheme, id, data } = props.view.resource
  return JSON.stringify([scheme, id, data.spaceId, data.directoryId, data.revision, data.path])
})
const selection = useResourceSelectionQuote({
  viewId: () => props.view.id,
  ownerKey: () => JSON.stringify([props.view.id, identity.value, mode.value]),
  visible: () => props.visible,
  language: () => props.language,
})
const attempt = shallowRef(0)
watch([identity, attempt], async (_, __, onCleanup) => {
  let active = true
  onCleanup(() => active = false)
  preview.value = null
  failed.value = false
  missing.value = false
  try {
    const value = await props.files.readFile(spaceFileTargetSchema.strip().parse(props.view.resource.data))
    if (active)
      preview.value = value
  }
  catch (error) {
    if (active) {
      failed.value = true
      missing.value = error instanceof Error && parseLocalChatPublicError(error.message)?.code === 'FILE_NOT_FOUND'
    }
  }
}, { immediate: true })
const document = useTemplateRef<InstanceType<typeof DesktopDocumentContent>>('document')
useResourceQuoteReveal({
  viewId: () => props.view.id,
  identity: () => identity.value,
  visible: () => props.visible,
  prepare: () => attempt.value++,
  ready: () => !!preview.value && !!document.value?.ready,
  reveal: quote => document.value?.reveal(quote) ?? false,
})
function loadPreview() {
  attempt.value++
}
function captureResource() {
  return { resource: spaceFileTargetSchema.strip().parse(props.view.resource.data) }
}
</script>

<template>
  <div class="file-preview flex flex-1 flex-col min-h-0 overflow-auto">
    <Teleport v-if="visible" :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <DesktopDocumentToolbar v-model="mode" :name="String(view.resource.data.path)" :modes="modes" :language="language" :embedded="!!toolbarTarget">
        <template #actions>
          <WorkbenchMenu target="resource.actions" :values="{ 'resource.scheme': view.resource.scheme }" :capture="captureResource" />
        </template>
      </DesktopDocumentToolbar>
    </Teleport>
    <div v-if="failed" class="flex items-center gap-[8px] p-[12px] text-muted text-[12px]" role="alert">
      <span>{{ missing ? labels.fileMissing : labels.failed }}</span>
      <button type="button" class="file-preview__retry border-0 bg-transparent p-0 text-accent cursor-pointer underline text-[12px] hover:opacity-85" @click="loadPreview">
        {{ labels.retry }}
      </button>
    </div>
    <DesktopFileLoading v-else-if="!preview && !previewRenderer" :loading="true" :label="labels.loading" />
    <p v-else-if="!(mode === 'preview' && previewRenderer) && (preview?.kind === 'binary' || preview?.kind === 'oversized')" class="p-[16px] text-muted text-[13px]" role="status">
      {{ language === 'en-US' ? (preview.kind === 'oversized' ? 'This file is too large for the built-in preview.' : 'No available reader supports this file.') : (preview.kind === 'oversized' ? '文件超出内置预览的大小限制。' : '暂无可用阅读器支持此文件。') }}
    </p>
    <DesktopDocumentContent
      v-else
      ref="document" :mode="mode" :name="view.title" :text="preview?.text" :image-url="preview?.imageUrl" :media-kind="preview?.kind === 'audio' || preview?.kind === 'video' ? preview.kind : null" :media-url="preview?.mediaUrl" :visible="visible" :wrap="view.state.wrap !== false" :language="language" :write-clipboard-text="writeClipboardText"
      :quote-source="selection.enabled ? quoteSource : undefined" :prepare-quote="selection.prepare" @preview-error="failed = true" @scroll.capture="selection.close"
    >
      <template v-if="previewRenderer" #preview>
        <component :is="previewRenderer.component" v-bind="previewRenderer.props" @error="failed = true" />
      </template>
    </DesktopDocumentContent>
    <ResourceSelectionQuoteMenu v-if="selection.enabled" :selection="selection" :language="language" />
  </div>
</template>
