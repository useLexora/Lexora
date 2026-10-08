<script setup lang="ts">
import type { SpaceFileMutation } from '@buddy-shared/spaces/spaceFileApi'
import type { DropdownOption, InputInst } from 'naive-ui'
import type { ComponentPublicInstance } from 'vue'
import type { TaskFilesContextTab } from '../../model/context-panel/taskContextPanel'
import type { WorkspaceFilesApi, WorkspaceMutationError } from '../../model/context-panel/workspaceFilesApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { FileTreeMenuTarget } from '@/shared/ui/files/fileTreeContextMenu'
import { validSpaceFileName } from '@buddy-shared/spaces/spaceFileNames'
import { NButton, NDropdown, NInput, NModal, useMessage } from 'naive-ui'
import { computed, nextTick, onScopeDispose, shallowRef, useId, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  tab: TaskFilesContextTab | null
  files: WorkspaceFilesApi
  language: BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
  refresh: (tab: TaskFilesContextTab) => Promise<boolean>
  expand: (tabId: string, path: string) => void
}>()
const emit = defineEmits<{ choose: [tabId: string, path: string, open: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const menuOpen = shallowRef(false)
const nameOpen = shallowRef(false)
const deleteOpen = shallowRef(false)
const busy = shallowRef(false)
const x = shallowRef(0)
const y = shallowRef(0)
const name = shallowRef('')
const error = shallowRef<WorkspaceMutationError | null>(null)
const action = shallowRef<SpaceFileMutation['operation']>('create-file')
const input = shallowRef<InputInst | null>(null)
const dialogStyle = { width: '440px', maxWidth: 'calc(100vw - 32px)' }
const nameInputId = useId()
const nameErrorId = useId()
const cancelDelete = shallowRef<ComponentPublicInstance | null>(null)
const captured = shallowRef<{ tab: TaskFilesContextTab, entry: FileTreeMenuTarget } | null>(null)
let focusTarget: HTMLElement | null = null
let generation = 0
let disposed = false
const identity = computed(() => props.tab ? JSON.stringify([props.tab.id, props.tab.target.spaceId, props.tab.target.directoryId, props.tab.target.revision]) : '')
function restoreFocus() {
  if (focusTarget?.isConnected)
    focusTarget.focus()
}
watch(identity, () => {
  generation++
  menuOpen.value = false
  nameOpen.value = false
  deleteOpen.value = false
  captured.value = null
  focusTarget = null
}, { flush: 'sync' })
watch(name, () => error.value = null)
onScopeDispose(() => {
  disposed = true
  generation++
})
const options = computed<DropdownOption[]>(() => {
  const entry = captured.value?.entry
  if (!entry)
    return []
  const items: DropdownOption[] = []
  if (!entry.unavailable) {
    if (entry.kind === 'file')
      items.push({ key: 'open', label: t('desktop.context.fileAction.open') })
    if (entry.kind === 'directory' && entry.writable && props.files.mutateEntry) {
      items.push({ key: 'create-file', label: t('desktop.context.fileAction.newFile') }, { key: 'create-directory', label: t('desktop.context.fileAction.newFolder') })
    }
    if (entry.path && entry.writable && props.files.mutateEntry) {
      items.push({ type: 'divider', key: 'modify-divider' }, { key: 'rename', label: t('desktop.context.fileAction.rename') }, { key: 'trash', label: t('desktop.context.fileAction.trash') })
    }
    if (entry.path) {
      items.push({ type: 'divider', key: 'path-divider' }, { key: 'copy-relative', label: t('desktop.context.fileAction.copyRelative') })
      if (props.files.locateEntry)
        items.push({ key: 'copy-full', label: t('desktop.context.fileAction.copyFull') })
    }
    items.push({ key: 'reveal', label: t(entry.kind === 'file' ? 'desktop.context.fileAction.reveal' : 'desktop.context.fileAction.openFolder') })
  }
  if (!entry.path || entry.unavailable)
    items.push({ key: 'refresh', label: t('desktop.context.refreshFiles') })
  return items.map(item => item.type === 'divider' ? item : { ...item, disabled: busy.value })
})
const title = computed(() => t(action.value === 'rename' ? 'desktop.context.fileAction.rename' : action.value === 'create-directory' ? 'desktop.context.fileAction.newFolder' : 'desktop.context.fileAction.newFile'))
const location = computed(() => {
  const state = captured.value
  if (!state)
    return ''
  const parent = action.value === 'rename' ? parentOf(state.entry.path) : state.entry.path
  return parent || state.tab.rootName
})
function parentOf(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}
function extension(value: string) {
  const dot = value.lastIndexOf('.')
  return dot > 0 ? value.slice(dot) : ''
}
const extensionChanged = computed(() => action.value === 'rename' && captured.value?.entry.kind === 'file' && extension(name.value) !== extension(captured.value.entry.name))
function show(entry: FileTreeMenuTarget) {
  if (!props.tab || busy.value)
    return
  generation++
  nameOpen.value = false
  deleteOpen.value = false
  captured.value = { tab: { ...props.tab, target: { ...props.tab.target } }, entry }
  error.value = null
  focusTarget = entry.event.currentTarget instanceof HTMLElement ? entry.event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null
  const bounds = focusTarget?.getBoundingClientRect()
  x.value = entry.event instanceof MouseEvent ? entry.event.clientX : bounds?.left ?? 0
  y.value = entry.event instanceof MouseEvent ? entry.event.clientY : bounds?.bottom ?? 0
  menuOpen.value = true
}
function hideMenu() {
  menuOpen.value = false
  restoreFocus()
}
async function focusName() {
  await nextTick()
  input.value?.focus()
  const dot = name.value.lastIndexOf('.')
  input.value?.inputElRef?.setSelectionRange(0, action.value === 'rename' && captured.value?.entry.kind === 'file' && dot > 0 ? dot : name.value.length)
}
async function select(key: string) {
  const state = captured.value
  if (!state || busy.value || !options.value.some(option => option.key === key && !option.disabled))
    return
  menuOpen.value = false
  if (key === 'create-file' || key === 'create-directory' || key === 'rename') {
    action.value = key
    name.value = key === 'rename' ? state.entry.name : key === 'create-file' ? t('desktop.context.fileAction.defaultFile') : t('desktop.context.fileAction.defaultFolder')
    error.value = null
    nameOpen.value = true
    return
  }
  if (key === 'trash') {
    action.value = 'trash'
    error.value = null
    deleteOpen.value = true
    return
  }
  if (key === 'open') {
    emit('choose', state.tab.id, state.entry.path, true)
    restoreFocus()
    return
  }
  const version = generation
  busy.value = true
  try {
    const target = { ...state.tab.target, path: state.entry.path }
    if (key === 'refresh')
      await props.refresh(state.tab)
    else if (key === 'reveal')
      await props.files.revealFile(target)
    else if (key === 'copy-relative')
      await props.writeClipboardText(state.entry.path)
    else if (key === 'copy-full' && props.files.locateEntry)
      await props.writeClipboardText((await props.files.locateEntry(target)).path)
  }
  catch {
    if (!disposed && generation === version)
      message.error(t('desktop.context.fileError.failed'))
  }
  finally {
    busy.value = false
    if (!disposed && generation === version)
      restoreFocus()
  }
}
async function closeRelated() {
  const state = captured.value
  if (!state || busy.value || !props.files.closeEntries)
    return
  busy.value = true
  const version = generation
  try {
    const closed = await props.files.closeEntries({ ...state.tab.target, path: state.entry.path })
    if (!disposed && version === generation && closed)
      error.value = null
  }
  catch {
    if (!disposed && version === generation)
      error.value = 'failed'
  }
  finally { busy.value = false }
}
async function submit() {
  const state = captured.value
  if (!state || !props.files.mutateEntry || busy.value || error.value === 'result-unknown')
    return
  const operation = action.value
  if (operation !== 'trash' && !validSpaceFileName(name.value)) {
    error.value = 'invalid-name'
    return
  }
  if (operation === 'rename' && name.value === state.entry.name) {
    nameOpen.value = false
    restoreFocus()
    return
  }
  const target = { ...state.tab.target, path: state.entry.path }
  const mutation: SpaceFileMutation = operation === 'trash' ? { ...target, operation } : { ...target, operation, name: name.value }
  const version = generation
  busy.value = true
  error.value = null
  try {
    const result = await props.files.mutateEntry(mutation)
    if (result.status === 'cancelled')
      return
    if (result.status === 'failed') {
      if (!disposed && version === generation)
        error.value = result.reason
      if (result.reason === 'result-unknown')
        await props.refresh(state.tab)
      return
    }
    const parent = operation === 'create-file' || operation === 'create-directory' ? state.entry.path : parentOf(state.entry.path)
    props.expand(state.tab.id, parent)
    const refreshed = await props.refresh(state.tab)
    if (disposed || version !== generation)
      return
    nameOpen.value = false
    deleteOpen.value = false
    emit('choose', state.tab.id, result.path, operation === 'create-file' && refreshed)
    if (!refreshed) {
      message.warning(t('desktop.context.fileAction.refreshFailedAfterChange'))
      return
    }
    if (operation === 'create-file' && props.files.openEntry) {
      try {
        if (!await props.files.openEntry({ ...state.tab.target, path: result.path }, state.tab.id))
          throw new Error('FILE_OPEN_FAILED')
      }
      catch {
        if (!disposed && version === generation)
          message.warning(t('desktop.context.fileAction.openFailedAfterCreate'))
      }
    }
    if (operation === 'trash')
      message.success(t('desktop.context.fileAction.trashed'))
  }
  catch {
    if (!disposed && version === generation)
      error.value = 'result-unknown'
    await props.refresh(state.tab)
  }
  finally {
    busy.value = false
    if (!disposed && version === generation && !nameOpen.value && !deleteOpen.value)
      restoreFocus()
  }
}
defineExpose({ show })
</script>

<template>
  <NDropdown :show="menuOpen" trigger="manual" placement="bottom-start" size="small" :x="x" :y="y" :options="options" :keyboard="true" @clickoutside="hideMenu" @select="select" @update:show="value => { if (!value) hideMenu() }" />
  <NModal v-model:show="nameOpen" preset="card" :title="title" class="workspace-entry-dialog" :style="dialogStyle" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" @after-enter="focusName" @after-leave="restoreFocus">
    <form @submit.prevent="submit">
      <p class="workspace-entry-location">
        {{ location }}
      </p>
      <label :for="nameInputId" class="workspace-entry-label">{{ t('desktop.context.fileAction.name') }}</label>
      <NInput ref="input" v-model:value="name" :disabled="busy || error === 'result-unknown'" :status="error ? 'error' : undefined" :input-props="{ 'id': nameInputId, 'aria-describedby': error ? nameErrorId : undefined }" />
      <p v-if="extensionChanged" class="workspace-entry-hint">
        {{ t('desktop.context.fileAction.extensionWarning') }}
      </p>
      <p v-if="error" :id="nameErrorId" class="workspace-entry-error" role="alert">
        {{ t(`desktop.context.fileError.${error}`) }}
      </p>
      <div class="workspace-entry-actions">
        <NButton v-if="error === 'open-resource' && files.closeEntries" size="small" :disabled="busy" @click="closeRelated">
          {{ t('desktop.context.fileAction.closeRelated') }}
        </NButton>
        <NButton size="small" :disabled="busy" @click="nameOpen = false">
          {{ t('desktop.context.fileAction.cancel') }}
        </NButton>
        <NButton size="small" type="primary" attr-type="submit" :loading="busy" :disabled="busy || error === 'result-unknown'">
          {{ action === 'rename' ? t('desktop.context.fileAction.confirmRename') : t('desktop.context.fileAction.create') }}
        </NButton>
      </div>
    </form>
  </NModal>
  <NModal v-model:show="deleteOpen" preset="card" :title="t('desktop.context.fileAction.trash')" class="workspace-entry-dialog" :style="dialogStyle" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" @after-enter="cancelDelete?.$el?.focus()" @after-leave="restoreFocus">
    <p class="workspace-entry-location">
      {{ captured?.entry.path }}
    </p>
    <p>{{ t(captured?.entry.kind === 'directory' ? 'desktop.context.fileAction.deleteFolderHint' : 'desktop.context.fileAction.deleteFileHint') }}</p>
    <p v-if="error" class="workspace-entry-error" role="alert">
      {{ t(`desktop.context.fileError.${error}`) }}
    </p>
    <div class="workspace-entry-actions">
      <NButton v-if="error === 'open-resource' && files.closeEntries" size="small" :disabled="busy" @click="closeRelated">
        {{ t('desktop.context.fileAction.closeRelated') }}
      </NButton>
      <NButton ref="cancelDelete" size="small" :disabled="busy" @click="deleteOpen = false">
        {{ t('desktop.context.fileAction.cancel') }}
      </NButton>
      <NButton size="small" type="error" :loading="busy" :disabled="busy || error === 'result-unknown'" @click="submit">
        {{ t('desktop.context.fileAction.trash') }}
      </NButton>
    </div>
  </NModal>
</template>

<style scoped>
.workspace-entry-location { margin: 0 0 12px; overflow-wrap: anywhere; color: var(--buddy-text-secondary); font-size: 12px; }
.workspace-entry-label { display: block; margin-bottom: 8px; }
.workspace-entry-hint { color: var(--buddy-text-secondary); font-size: 12px; }
.workspace-entry-error { color: var(--buddy-status-danger-text); font-size: 12px; }
.workspace-entry-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>
