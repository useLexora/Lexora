import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { SpaceDirectorySource, TaskSpaceInput, TaskSpacePrimaryDirectoryInput } from '../../state/task-index/typing'
import { computed, onScopeDispose, reactive, readonly, shallowRef, watch } from 'vue'

interface SpaceEditorOptions {
  show: () => boolean
  space: () => LocalSpace | null
  selectDirectory: (source?: SpaceDirectorySource) => Promise<string | null>
  save: (input: TaskSpaceInput) => Promise<boolean>
  onSaved: () => void
}

export function useSpaceEditor(options: SpaceEditorOptions) {
  const form = reactive<TaskSpaceInput & { additionalDirectories: TaskSpacePrimaryDirectoryInput[] }>({ additionalDirectories: [], icon: 'folder', iconColor: 'default', memoryScope: 'personal_and_space', name: '', primaryDirectory: null })
  let initialAdditionalDirectoryIds: string[] = []
  const saving = shallowRef(false)
  const selectingDirectory = shallowRef(false)
  const failed = shallowRef(false)
  let session = 0
  watch([options.show, () => options.space()?.id], ([show]) => {
    session += 1
    saving.value = false
    selectingDirectory.value = false
    failed.value = false
    if (!show)
      return
    const space = options.space()
    initialAdditionalDirectoryIds = space?.additionalDirectories.map(directory => directory.id) ?? []
    Object.assign(form, {
      additionalDirectories: space?.additionalDirectories.map(directory => ({ id: directory.id, root: directory.root })) ?? [],
      icon: space?.icon ?? 'folder',
      iconColor: space?.iconColor ?? 'default',
      memoryScope: space?.memoryScope ?? 'personal_and_space',
      name: space?.name ?? '',
      primaryDirectory: space?.primaryDirectory ? { id: space.primaryDirectory.id, root: space.primaryDirectory.root } : null,
    })
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => {
    session += 1
  })
  const directoryEditingDisabled = computed(() => Boolean(options.space()?.activeRunCount))
  const additionalDirectoryChanges = computed(() => ({
    add: form.additionalDirectories.filter(directory => !directory.id).map(directory => directory.root),
    remove: initialAdditionalDirectoryIds.filter(id => !form.additionalDirectories.some(directory => directory.id === id)),
  }))
  const directoryConfigurationChanged = computed(() => {
    const existing = options.space()?.primaryDirectory
    return (form.primaryDirectory?.id ?? null) !== (existing?.id ?? null)
      || (form.primaryDirectory?.root ?? null) !== (existing?.root ?? null)
      || additionalDirectoryChanges.value.add.length > 0 || additionalDirectoryChanges.value.remove.length > 0
  })
  const directoryChangeBlocked = computed(() => directoryEditingDisabled.value && directoryConfigurationChanged.value)
  const canSave = computed(() => Boolean(form.name.trim()) && !saving.value && !selectingDirectory.value && !directoryChangeBlocked.value)

  async function selectPrimaryDirectory(source?: SpaceDirectorySource) {
    if (form.primaryDirectory || directoryEditingDisabled.value || selectingDirectory.value || saving.value)
      return
    const current = session
    selectingDirectory.value = true
    failed.value = false
    try {
      const selected = await options.selectDirectory(source)
      if (!selected || current !== session || directoryEditingDisabled.value)
        return
      const existing = options.space()?.additionalDirectories.find(directory => directory.root === selected)
      form.primaryDirectory = { id: existing?.id ?? null, root: selected }
      form.additionalDirectories = form.additionalDirectories.filter(directory => directory.root !== selected)
      if (!options.space() && !form.name.trim())
        form.name = selected.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    }
    catch {
      if (current === session)
        failed.value = true
    }
    finally {
      if (current === session)
        selectingDirectory.value = false
    }
  }

  async function selectAdditionalDirectory(source?: SpaceDirectorySource) {
    if (directoryEditingDisabled.value || selectingDirectory.value || saving.value || form.additionalDirectories.length + Number(Boolean(form.primaryDirectory)) >= 32)
      return
    const current = session
    selectingDirectory.value = true
    failed.value = false
    try {
      const selected = await options.selectDirectory(source)
      if (!selected || current !== session || directoryEditingDisabled.value
        || selected === form.primaryDirectory?.root || form.additionalDirectories.some(directory => directory.root === selected)) {
        return
      }
      const existing = options.space()?.additionalDirectories.find(directory => directory.root === selected)
      form.additionalDirectories.push({ id: existing?.id ?? null, root: selected })
    }
    catch {
      if (current === session)
        failed.value = true
    }
    finally {
      if (current === session)
        selectingDirectory.value = false
    }
  }

  function removeAdditionalDirectory(index: number) {
    if (!directoryEditingDisabled.value && !saving.value && !selectingDirectory.value)
      form.additionalDirectories.splice(index, 1)
  }

  async function save() {
    if (!options.show() || !canSave.value)
      return
    const current = session
    const input: TaskSpaceInput = {
      additionalDirectoryChanges: { add: [...additionalDirectoryChanges.value.add], remove: [...additionalDirectoryChanges.value.remove] },
      icon: form.icon,
      iconColor: form.iconColor,
      memoryScope: form.memoryScope,
      name: form.name.trim(),
      primaryDirectory: form.primaryDirectory ? { ...form.primaryDirectory } : null,
    }
    const editingValue = JSON.stringify(form)
    saving.value = true
    failed.value = false
    try {
      const saved = await options.save(input)
      if (current !== session)
        return
      failed.value = !saved
      if (saved && JSON.stringify(form) === editingValue)
        options.onSaved()
    }
    catch {
      if (current === session)
        failed.value = true
    }
    finally {
      if (current === session)
        saving.value = false
    }
  }

  return { canSave, directoryChangeBlocked, directoryEditingDisabled, failed: readonly(failed), form, save, saving: readonly(saving), selectingDirectory: readonly(selectingDirectory), selectPrimaryDirectory, selectAdditionalDirectory, removeAdditionalDirectory }
}
