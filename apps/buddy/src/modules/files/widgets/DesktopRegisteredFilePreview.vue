<script setup lang="ts">
import type { FileOpeningProvider } from '@buddy-shared/files/fileOpening'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import { computed, shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import WorkbenchSurface from '@/workbench/browser/WorkbenchSurface.vue'

const props = defineProps<{ ownerId: string, provider: FileOpeningProvider, target: SpaceFileTarget, text?: string, visible: boolean, language: 'zh-CN' | 'en-US' }>()
const { controller, revision } = useWorkbench()
const api = requireDesktopApi().extensions
const failed = shallowRef(false)
const attempt = shallowRef(0)
const childId = shallowRef<string | null>(null)
const currentView = computed(() => {
  void revision.value
  return childId.value ? controller.layout.views[childId.value] : null
})
watch([() => props.provider.id, () => props.provider.viewTypes?.inline, () => JSON.stringify(props.target), () => props.text, () => attempt.value], (_, __, cleanup) => {
  const abort = new AbortController()
  failed.value = false
  const timer = setTimeout(() => {
    void prepare().catch(() => {
      if (!abort.signal.aborted)
        failed.value = true
    })
  }, props.text === undefined ? 0 : 200)
  cleanup(() => {
    abort.abort()
    clearTimeout(timer)
  })
  async function prepare() {
    const prepared = await api.prepareFileOpening({ providerId: props.provider.id, location: 'inline', source: { kind: 'space', target: props.target }, text: props.text })
    if (abort.signal.aborted || !controller.layout.views[props.ownerId])
      return
    const resource = { scheme: 'extension', id: `inline:${props.ownerId}:${props.provider.id}`, data: { extensionId: prepared.extensionId, viewType: prepared.viewType, resource: prepared.resource } }
    const existing = Object.values(controller.layout.views).find(view => view.state.inlineOwner === props.ownerId)
    if (existing?.resource.id === resource.id && existing.type === prepared.viewType) {
      controller.updateView(existing.id, { resource })
      childId.value = existing.id
    }
    else {
      if (existing && !(await controller.close(existing.id, abort.signal)).committed)
        throw new Error('FILE_PREVIEW_REPLACEMENT_CANCELLED')
      if (abort.signal.aborted || !controller.layout.views[props.ownerId])
        return
      childId.value = await controller.open(resource, props.provider.title, { signal: abort.signal, viewType: prepared.viewType, location: 'context', focus: false, duplicate: true, state: { inlineOwner: props.ownerId, version: 0, value: {} } }) ?? null
      if (!childId.value)
        throw new Error('FILE_OPENER_UNAVAILABLE')
    }
  }
}, { immediate: true })
</script>

<template>
  <div class="flex flex-1 min-h-0 flex-col" data-testid="registered-file-preview">
    <div v-if="failed" class="p-[12px] text-muted text-[12px]" role="alert">
      {{ language === 'en-US' ? 'Unable to open this preview.' : '无法打开此预览。' }}
      <button type="button" class="border-0 bg-transparent text-accent cursor-pointer underline" @click="attempt++">
        {{ language === 'en-US' ? 'Retry' : '重试' }}
      </button>
    </div>
    <WorkbenchSurface v-else-if="currentView" :view-id="currentView.id" :visible="visible" />
    <p v-else class="p-[12px] text-muted text-[12px]" role="status">
      {{ language === 'en-US' ? 'Loading preview…' : '正在加载预览…' }}
    </p>
  </div>
</template>
