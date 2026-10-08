<script setup lang="ts">
import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { TextModelPool } from '@/workbench/browser/TextModelPool'
import type { ResourceRef, WorkbenchView } from '@/workbench/common/workbench'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { NButton } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, isMarkdownFile, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import { observeDesktopMonacoTheme } from '@/shared/ui/monaco/desktopMonaco'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

const props = withDefaults(defineProps<{ view: WorkbenchView, models: TextModelPool, language: 'zh-CN' | 'en-US', writeClipboardText: (text: string) => Promise<void>, toolbarTarget?: HTMLElement | null, visible?: boolean }>(), { visible: true })
const { copies, controller, labels } = useWorkbench()
const { t } = useBuddyI18n(() => props.language)
const container = useTemplateRef<HTMLElement>('container')
const failed = shallowRef(false)
const copy = shallowRef(copies.get(props.view.resource))
const modes = computed(() => fileDocumentModes({ preview: isMarkdownFile(props.view.title), source: !!copy.value?.etag, edit: !!copy.value?.etag }))
const mode = computed({
  get: () => resolveFileDocumentMode(props.view.state.mode ?? (props.view.state.preview === false ? 'edit' : undefined), modes.value),
  set: value => controller.updateView(props.view.id, { state: { ...props.view.state, mode: value } }),
})
function resourceIdentity(resource: ResourceRef): string {
  const { scheme, id, data } = resource
  return JSON.stringify([scheme, id, data.spaceId, data.directoryId, data.revision, data.path])
}
const identity = computed(() => resourceIdentity(props.view.resource))
const viewId = computed(() => props.view.id)
let editor: Monaco.editor.IStandaloneCodeEditor | undefined
const attempt = shallowRef(0)
watch(identity, (_, __, onCleanup) => {
  const resource = props.view.resource
  let active = true
  failed.value = false
  copy.value = copies.get(resource)
  onCleanup(copies.onDidChangeResource(resource)(() => copy.value = copies.get(resource)).dispose)
  onCleanup(() => active = false)
  void copies.open(resource).catch(() => {
    if (active)
      failed.value = true
  })
}, { immediate: true })
watch([container, attempt, viewId, identity], async ([element, , viewId, key], _, onCleanup) => {
  const resource = props.view.resource
  let disposed = false
  let ownedEditor: Monaco.editor.IStandaloneCodeEditor | undefined
  let capture: ReturnType<typeof setTimeout> | undefined
  let release: (() => void) | undefined
  let stopTheme: (() => void) | undefined
  function state() {
    const view = controller.layout.views[viewId] ?? controller.navigation.find(viewId)?.view
    if (!view || resourceIdentity(view.resource) !== key)
      return
    const viewState = ownedEditor?.saveViewState()
    if (viewState)
      controller.updateView(viewId, { state: { ...view.state, editor: JSON.parse(JSON.stringify(viewState)) as JsonValue } })
  }
  function dispose(save = true) {
    if (disposed)
      return
    disposed = true
    clearTimeout(capture)
    try {
      if (save)
        state()
    }
    finally {
      if (editor === ownedEditor)
        editor = undefined
      stopTheme?.()
      try {
        ownedEditor?.dispose()
      }
      finally { release?.() }
    }
  }
  onCleanup(dispose)
  if (!element)
    return
  try {
    const lease = await props.models.acquire(resource)
    if (disposed) {
      lease.release()
      return
    }
    release = lease.release
    ownedEditor = lease.monaco.editor.create(element, {
      model: lease.model,
      readOnly: mode.value !== 'edit' || !!copy.value?.blocked,
      domReadOnly: mode.value !== 'edit' || !!copy.value?.blocked,
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      wordWrap: (props.view.state.wrap ?? controller.configuration.get('workbench.wordWrap')) ? 'on' : 'off',
      tabSize: Number(controller.configuration.get('workbench.tabSize') ?? 2),
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
    })
    editor = ownedEditor
    stopTheme = observeDesktopMonacoTheme(lease.monaco)
    if (props.view.state.editor)
      ownedEditor.restoreViewState(JSON.parse(JSON.stringify(props.view.state.editor)) as Monaco.editor.ICodeEditorViewState)
    const schedule = () => {
      if (disposed)
        return
      clearTimeout(capture)
      capture = setTimeout(state, 250)
    }
    ownedEditor.onDidChangeCursorPosition(schedule)
    ownedEditor.onDidScrollChange(schedule)
  }
  catch {
    const active = !disposed
    dispose(false)
    if (active)
      failed.value = true
  }
}, { immediate: true })
watch([mode, () => copy.value?.blocked], ([value, blocked]) => editor?.updateOptions({ readOnly: value !== 'edit' || !!blocked, domReadOnly: value !== 'edit' || !!blocked }), { flush: 'sync' })
watch(() => props.view.state.wrap, value => editor?.updateOptions({ wordWrap: (value ?? controller.configuration.get('workbench.wordWrap')) ? 'on' : 'off' }))
async function retry() {
  const key = identity.value
  const resource = props.view.resource
  failed.value = false
  try {
    await copies.open(resource)
    if (identity.value === key)
      attempt.value++
  }
  catch {
    if (identity.value === key)
      failed.value = true
  }
}
onScopeDispose(controller.configuration.subscribe(() => editor?.updateOptions({ wordWrap: (props.view.state.wrap ?? controller.configuration.get('workbench.wordWrap')) ? 'on' : 'off', tabSize: Number(controller.configuration.get('workbench.tabSize') ?? 2) })))
</script>

<template>
  <div class="file-editor" :data-dirty="copy?.dirty">
    <p v-if="copy?.blocked" role="status">
      {{ t('desktop.context.fileAction.mutationBlocked') }}
    </p>
    <Teleport v-if="visible" :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <DesktopDocumentToolbar v-model="mode" :name="String(view.resource.data.path)" :modes="modes" :language="language" :embedded="!!toolbarTarget">
        <template #actions>
          <WorkbenchMenu target="resource.actions" :values="{ 'resource.scheme': view.resource.scheme }" :capture="() => ({ resource: spaceFileTargetSchema.parse(view.resource.data) })" />
          <NButton v-if="mode === 'edit' || copy?.dirty" size="tiny" secondary :loading="copy?.saving" :disabled="!copy || copy.loading || copy.saving || copy.blocked || !!copy.conflict || !copy.dirty" @click="copies.save(view.resource)">
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
    <footer v-if="mode === 'edit' || copy?.dirty" class="file-editor__status">
      {{ copy?.loading ? labels.loading : copy?.dirty ? labels.dirty : labels.saved }} · UTF-8
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
