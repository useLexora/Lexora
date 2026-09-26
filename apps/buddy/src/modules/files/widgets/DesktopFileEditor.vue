<script setup lang="ts">
import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { TextModelPool } from '@/workbench/browser/TextModelPool'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { NButton } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, useTemplateRef, watch } from 'vue'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, isMarkdownFile, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import { observeDesktopMonacoTheme } from '@/shared/ui/monaco/desktopMonaco'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

const props = withDefaults(defineProps<{ view: WorkbenchView, models: TextModelPool, language: 'zh-CN' | 'en-US', writeClipboardText: (text: string) => Promise<void>, toolbarTarget?: HTMLElement | null, visible?: boolean }>(), { visible: true })
const { copies, controller, revision, labels } = useWorkbench()
const container = useTemplateRef<HTMLElement>('container')
const failed = shallowRef(false)
const copy = computed(() => {
  void revision.value
  const value = copies.get(props.view.resource)
  return value ? { ...value } : undefined
})
const modes = computed(() => fileDocumentModes({ preview: isMarkdownFile(props.view.title), source: !!copy.value?.etag, edit: !!copy.value?.etag }))
const mode = computed({
  get: () => resolveFileDocumentMode(props.view.state.mode ?? (props.view.state.preview === false ? 'edit' : undefined), modes.value),
  set: value => controller.updateView(props.view.id, { state: { ...props.view.state, mode: value } }),
})
let editor: Monaco.editor.IStandaloneCodeEditor | undefined
let capture: ReturnType<typeof setTimeout> | undefined
const attempt = shallowRef(0)
watch(() => props.view.resource, resource => void copies.open(resource), { immediate: true })
function state() {
  const viewState = editor?.saveViewState()
  if (viewState)
    controller.updateView(props.view.id, { state: { ...props.view.state, editor: JSON.parse(JSON.stringify(viewState)) as JsonValue } })
}
onScopeDispose(() => clearTimeout(capture))
watch([container, attempt], async ([element], _, onCleanup) => {
  let disposed = false
  let release: (() => void) | undefined
  let stopTheme: (() => void) | undefined
  onCleanup(() => {
    disposed = true
    state()
    editor?.dispose()
    editor = undefined
    stopTheme?.()
    release?.()
  })
  if (!element)
    return
  try {
    const lease = await props.models.acquire(props.view.resource)
    if (disposed) {
      lease.release()
      return
    }
    release = lease.release
    editor = lease.monaco.editor.create(element, {
      model: lease.model,
      readOnly: mode.value !== 'edit',
      domReadOnly: mode.value !== 'edit',
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      wordWrap: (props.view.state.wrap ?? controller.configuration.get('workbench.wordWrap')) ? 'on' : 'off',
      tabSize: Number(controller.configuration.get('workbench.tabSize') ?? 2),
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
    })
    stopTheme = observeDesktopMonacoTheme(lease.monaco)
    if (props.view.state.editor)
      editor.restoreViewState(props.view.state.editor as unknown as Monaco.editor.ICodeEditorViewState)
    const schedule = () => {
      clearTimeout(capture)
      capture = setTimeout(state, 250)
    }
    editor.onDidChangeCursorPosition(schedule)
    editor.onDidScrollChange(schedule)
  }
  catch {
    if (!disposed)
      failed.value = true
  }
}, { immediate: true })
watch(mode, value => editor?.updateOptions({ readOnly: value !== 'edit', domReadOnly: value !== 'edit' }))
watch(() => props.view.state.wrap, value => editor?.updateOptions({ wordWrap: (value ?? controller.configuration.get('workbench.wordWrap')) ? 'on' : 'off' }))
async function retry() {
  failed.value = false
  await copies.open(props.view.resource)
  attempt.value++
}
onScopeDispose(controller.configuration.subscribe(() => editor?.updateOptions({ wordWrap: (props.view.state.wrap ?? controller.configuration.get('workbench.wordWrap')) ? 'on' : 'off', tabSize: Number(controller.configuration.get('workbench.tabSize') ?? 2) })))
</script>

<template>
  <div class="file-editor" :data-dirty="copies.dirty(view.resource)">
    <Teleport v-if="visible" :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <DesktopDocumentToolbar v-model="mode" :name="String(view.resource.data.path)" :modes="modes" :language="language" :embedded="!!toolbarTarget">
        <template #actions>
          <WorkbenchMenu target="resource.actions" :values="{ 'resource.scheme': view.resource.scheme }" :capture="() => ({ resource: spaceFileTargetSchema.parse(view.resource.data) })" />
          <NButton v-if="mode === 'edit' || copies.dirty(view.resource)" size="tiny" secondary :loading="copy?.saving" :disabled="!copy || copy.loading || copy.saving || !!copy.conflict || !copies.dirty(view.resource)" @click="copies.save(view.resource)">
            {{ labels.save }}
          </NButton>
        </template>
      </DesktopDocumentToolbar>
    </Teleport>
    <section v-if="copy?.conflict" class="file-editor__conflict" role="alert">
      <p>{{ labels.conflict }}</p>
      <details><summary>{{ labels.diskVersion }}</summary><pre>{{ copy.conflict.text }}</pre></details>
      <button type="button" @click="copies.resolveConflict(view.resource, 'disk')">
        {{ labels.disk }}
      </button>
      <button type="button" @click="copies.resolveConflict(view.resource, 'local')">
        {{ labels.local }}
      </button>
    </section>
    <div v-if="copy?.error || failed" class="file-editor__error" role="alert">
      {{ labels.failed }} <button type="button" @click="retry">
        {{ labels.retry }}
      </button>
    </div>
    <DesktopDocumentContent :mode="mode" :name="view.title" :text="copy?.text ?? ''" :language="language" :write-clipboard-text="writeClipboardText">
      <template #source>
        <div ref="container" class="file-editor__monaco" data-testid="workbench-text-editor" />
      </template>
    </DesktopDocumentContent>
    <footer v-if="mode === 'edit' || copies.dirty(view.resource)" class="file-editor__status">
      {{ copy?.loading ? labels.loading : copies.dirty(view.resource) ? labels.dirty : labels.saved }} · UTF-8
    </footer>
  </div>
</template>

<style scoped>
.file-editor { display: flex; flex: 1; min-height: 0; min-width: 0; flex-direction: column; }
.file-editor__conflict button, .file-editor__error button { padding: 3px 7px; background: var(--buddy-state-hover); border: 1px solid var(--buddy-border-subtle); border-radius: 4px; color: var(--buddy-text-secondary); cursor: pointer; }
.file-editor__monaco { flex: 1; min-height: 0; }
.file-editor__conflict, .file-editor__error { padding: 10px 14px; font-size: 12px; background: var(--buddy-state-hover); }
.file-editor__conflict pre { max-height: 150px; overflow: auto; white-space: pre-wrap; }
.file-editor__status { flex: none; padding: 3px 12px; color: var(--buddy-text-secondary); border-top: 1px solid var(--buddy-border-subtle); font-size: 10px; }
</style>
