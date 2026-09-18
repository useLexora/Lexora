<script setup lang="ts">
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpaceFilePreview, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { computed, shallowRef, watch } from 'vue'
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
watch(() => props.view.resource, async (resource, _, onCleanup) => {
  let active = true
  preview.value = null
  failed.value = false
  onCleanup(() => active = false)
  try {
    const result = await props.files.readFile(resource.data as unknown as SpaceFileTarget)
    if (active)
      preview.value = result
  }
  catch {
    if (active)
      failed.value = true
  }
}, { immediate: true })
</script>

<template>
  <div class="file-preview">
    <Teleport v-if="visible" :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <DesktopDocumentToolbar v-model="mode" :name="String(view.resource.data.path)" :modes="modes" :language="language" :embedded="!!toolbarTarget" />
    </Teleport>
    <div v-if="failed" class="file-preview__notice" role="alert">
      {{ labels.failed }}
    </div>
    <DesktopDocumentContent v-else :mode="mode" :name="view.title" :text="preview?.text" :image-url="preview?.imageUrl" :wrap="view.state.wrap !== false" :language="language" :write-clipboard-text="writeClipboardText" />
  </div>
</template>

<style scoped>
.file-preview { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: auto; }
.file-preview__notice { padding: 12px; color: var(--buddy-text-secondary); font-size: 12px; }
</style>
