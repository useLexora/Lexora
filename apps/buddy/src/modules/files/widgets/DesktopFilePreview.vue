<script setup lang="ts">
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { computed, shallowRef, watch } from 'vue'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, isMarkdownFile, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

const props = withDefaults(defineProps<{ view: WorkbenchView, files: LocalChatApi['spaces'], language: 'zh-CN' | 'en-US', writeClipboardText: (text: string) => Promise<void>, toolbarTarget?: HTMLElement | null, visible?: boolean }>(), { visible: true })
const { labels, controller } = useWorkbench()
const preview = shallowRef<LocalSpaceFilePreview | null>(null)
const failed = shallowRef(false)
const modes = computed(() => fileDocumentModes({ preview: preview.value?.kind === 'image' || (preview.value?.kind === 'text' && isMarkdownFile(props.view.title)), source: preview.value?.kind === 'text', edit: false }))
const mode = computed({ get: () => resolveFileDocumentMode(props.view.state.mode, modes.value), set: value => controller.updateView(props.view.id, { state: { ...props.view.state, mode: value } }) })
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
    const value = await props.files.readFile(spaceFileTargetSchema.parse(props.view.resource.data))
    if (active)
      preview.value = value
  }
  catch {
    if (active)
      failed.value = true
  }
}, { immediate: true })
function loadPreview() {
  attempt.value++
}
</script>

<template>
  <div class="file-preview">
    <Teleport v-if="visible" :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <DesktopDocumentToolbar v-model="mode" :name="String(view.resource.data.path)" :modes="modes" :language="language" :embedded="!!toolbarTarget">
        <template #actions>
          <WorkbenchMenu target="resource.actions" :values="{ 'resource.scheme': view.resource.scheme }" :capture="() => ({ resource: spaceFileTargetSchema.parse(view.resource.data) })" />
        </template>
      </DesktopDocumentToolbar>
    </Teleport>
    <div v-if="failed" class="file-preview__notice" role="alert">
      <span>{{ labels.failed }}</span>
      <button type="button" class="file-preview__retry" @click="loadPreview">
        {{ labels.retry }}
      </button>
    </div>
    <DesktopDocumentContent v-else :mode="mode" :name="view.title" :text="preview?.text" :image-url="preview?.imageUrl" :wrap="view.state.wrap !== false" :language="language" :write-clipboard-text="writeClipboardText" />
  </div>
</template>

<style scoped>
.file-preview { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: auto; }
.file-preview__notice { display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--buddy-text-secondary); font-size: 12px; }
.file-preview__retry { border: 0; background: transparent; padding: 0; color: var(--buddy-accent-solid); cursor: pointer; text-decoration: underline; font: inherit; font-size: 12px; }
.file-preview__retry:hover { opacity: 0.85; }
</style>
