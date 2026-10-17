<script setup lang="ts">
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyFileQuote, BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, isMarkdownFile, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import ResourceSelectionQuoteMenu from '@/shared/ui/selection/ResourceSelectionQuoteMenu.vue'
import { useResourceQuoteReveal } from '@/shared/ui/selection/useResourceQuoteReveal'
import { useSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

const props = withDefaults(defineProps<{ view: WorkbenchView, files: LocalChatApi['spaces'], language: 'zh-CN' | 'en-US', writeClipboardText: (text: string) => Promise<void>, toolbarTarget?: HTMLElement | null, visible?: boolean }>(), { visible: true })
const { labels, controller } = useWorkbench()
const preview = shallowRef<LocalSpaceFilePreview | null>(null)
const quoteMenu = useTemplateRef<InstanceType<typeof ResourceSelectionQuoteMenu>>('quoteMenu')
const references = useSelectionReferences()
function captureMonacoQuote(quote: BuddyResourceQuote) {
  return quoteMenu.value?.captureMonaco(quote) ?? null
}
function prepareQuote(quote: BuddyResourceQuote, x: number, y: number) {
  return quoteMenu.value?.prepare(quote, x, y) ?? null
}
const failed = shallowRef(false)
const modes = computed(() => fileDocumentModes({ preview: preview.value?.kind === 'image' || (preview.value?.kind === 'text' && isMarkdownFile(props.view.title)), source: preview.value?.kind === 'text', edit: false }))
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
const attempt = shallowRef(0)
watch([identity, attempt], async (_, __, onCleanup) => {
  let active = true
  onCleanup(() => active = false)
  preview.value = null
  failed.value = false
  try {
    const value = await props.files.readFile(spaceFileTargetSchema.strip().parse(props.view.resource.data))
    if (active)
      preview.value = value
  }
  catch {
    if (active)
      failed.value = true
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
      <span>{{ labels.failed }}</span>
      <button type="button" class="file-preview__retry border-0 bg-transparent p-0 text-accent cursor-pointer underline text-[12px] hover:opacity-85" @click="loadPreview">
        {{ labels.retry }}
      </button>
    </div>
    <DesktopFileLoading v-else-if="!preview" :loading="true" :label="labels.loading" />
    <DesktopDocumentContent
      v-else
      ref="document" :mode="mode" :name="view.title" :text="preview?.text" :image-url="preview?.imageUrl" :wrap="view.state.wrap !== false" :language="language" :write-clipboard-text="writeClipboardText"
      :quote-source="references ? quoteSource : undefined" :prepare-quote="prepareQuote" :capture-monaco-quote="captureMonacoQuote" @scroll.capture="quoteMenu?.close()"
    />
    <ResourceSelectionQuoteMenu v-if="references" ref="quoteMenu" :view-id="view.id" :owner-key="`${view.id}:${identity}:${mode}`" :language="language" :visible="visible" />
  </div>
</template>
