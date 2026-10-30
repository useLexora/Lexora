import type { ImageCatalog, ImageOperation, ImagePolicy, ImagePreferences } from '@buddy-shared/images/imagePreferences'
import { imagePolicySchema, imagePolicyTargets, imagePreferencesSchema, isSeparateOcrEnabled } from '@buddy-shared/images/imagePreferences'
import { useEventListener } from '@vueuse/core'
import { computed, onMounted, onScopeDispose, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

type ImageSettingField = ImageOperation | 'ocrEnabled'
type ImageSettingChange = { field: ImageOperation, value: ImagePolicy | undefined } | { field: 'ocrEnabled', value: boolean }
type ImageSettingEdit = ImageSettingChange & { revision: number }

function applyEdit(preferences: ImagePreferences, edit: ImageSettingChange) {
  if (edit.field === 'ocrEnabled')
    preferences.ocrEnabled = edit.value
  else if (edit.value === undefined)
    delete preferences[edit.field]
  else
    preferences[edit.field] = edit.value
}

function operationForField(field: ImageSettingField): ImageOperation {
  return field === 'ocrEnabled' ? 'extract' : field
}

export function useImageSettings() {
  const api = requireDesktopApi()
  const catalog = shallowRef<ImageCatalog>({ candidates: [], readingCandidates: [], preferences: {} })
  const draft = shallowRef<ImagePreferences>({})
  const loading = shallowRef(true)
  const initialized = shallowRef(false)
  const failed = shallowRef(false)
  const savingOperations = shallowRef<ReadonlySet<ImageOperation>>(new Set())
  const failedFields = shallowRef<ReadonlySet<ImageSettingField>>(new Set())
  const failedOperations = computed(() => new Set([...failedFields.value].map(operationForField)))
  const candidates = computed(() => [...catalog.value.candidates, ...catalog.value.readingCandidates])
  const ocrEnabled = computed(() => isSeparateOcrEnabled(draft.value))
  const edits = new Map<ImageSettingField, ImageSettingEdit>()
  const pending = new Map<ImageSettingField, ImageSettingEdit>()
  let persisted: ImagePreferences = {}
  let inFlight = new Map<ImageSettingField, ImageSettingEdit>()
  let active = true
  let flushing = false
  let requestVersion = 0
  let editRevision = 0
  let refreshPending = false

  function updateSavingOperations() {
    if (active)
      savingOperations.value = new Set([...inFlight.keys(), ...pending.keys()].map(operationForField))
  }
  function clearFailure(field: ImageSettingField) {
    const next = new Set(failedFields.value)
    next.delete(field)
    failedFields.value = next
  }
  async function flush() {
    if (flushing || !initialized.value)
      return
    flushing = true
    try {
      while (pending.size) {
        inFlight = new Map(pending)
        pending.clear()
        requestVersion++
        updateSavingOperations()
        try {
          const next = { ...persisted }
          for (const edit of inFlight.values())
            applyEdit(next, edit)
          const saved = imagePreferencesSchema.parse(next)
          await api.images.save(saved)
          persisted = saved
          if (active) {
            catalog.value = { ...catalog.value, preferences: saved }
            for (const [operation, edit] of inFlight) {
              if (edits.get(operation)?.revision === edit.revision)
                edits.delete(operation)
            }
          }
        }
        catch {
          if (active) {
            const next = new Set(failedFields.value)
            for (const [operation, edit] of inFlight) {
              if (edits.get(operation)?.revision === edit.revision)
                next.add(operation)
            }
            failedFields.value = next
          }
        }
        finally {
          inFlight = new Map()
          updateSavingOperations()
        }
      }
    }
    finally {
      flushing = false
      if (active && refreshPending) {
        refreshPending = false
        void refresh()
      }
    }
  }
  function enqueue(edit: ImageSettingEdit) {
    pending.delete(edit.field)
    if (edit.field === 'ocrEnabled' || edit.value === undefined || imagePolicySchema.safeParse(edit.value).success)
      pending.set(edit.field, edit)
  }
  async function refresh() {
    if (!active)
      return
    if (flushing) {
      refreshPending = true
      return
    }
    const version = ++requestVersion
    try {
      const next = await api.images.catalog()
      if (!active || version !== requestVersion)
        return
      persisted = next.preferences
      const nextDraft = { ...next.preferences }
      for (const edit of edits.values())
        applyEdit(nextDraft, edit)
      draft.value = nextDraft
      catalog.value = next
      initialized.value = true
      loading.value = false
      failed.value = false
      void flush()
    }
    catch {
      if (active && version === requestVersion)
        failed.value = true
    }
    finally {
      if (active && version === requestVersion)
        loading.value = false
    }
  }
  function edit(change: ImageSettingChange) {
    if (!active)
      return
    const changes: ImageSettingChange[] = change.field === 'extract' && draft.value.ocrEnabled === undefined
      ? [{ field: 'ocrEnabled', value: ocrEnabled.value }, change]
      : [change]
    const next = { ...draft.value }
    for (const change of changes) {
      const update = { ...change, revision: ++editRevision }
      applyEdit(next, update)
      edits.set(update.field, update)
      clearFailure(update.field)
      enqueue(update)
    }
    draft.value = next
    updateSavingOperations()
    void flush()
  }
  function change(operation: ImageOperation, value: ImagePolicy) {
    const targets = imagePolicyTargets(value)
    edit({ field: operation, value: { mode: value.mode, target: targets[0] ?? null, fallbacks: targets.slice(1) } })
  }
  function inherit(operation: 'extract' | 'document' | 'edit') {
    edit({ field: operation, value: undefined })
  }
  function changeOcrEnabled(enabled: boolean) {
    edit({ field: 'ocrEnabled', value: enabled })
  }
  function retry(operation: ImageOperation) {
    if (!active)
      return
    for (const [field, update] of edits) {
      if (operationForField(field) !== operation || !failedFields.value.has(field))
        continue
      clearFailure(field)
      enqueue(update)
    }
    updateSavingOperations()
    void flush()
  }
  function legacy(operation: 'document' | 'edit' | 'extract') {
    const value = draft.value[operation]
    if (!value || (operation === 'extract' && draft.value.ocrService))
      return undefined
    return value
  }
  const stopProviders = api.localChat.providers.onChanged(() => void refresh())
  const stopExtensions = api.extensions.onChanged(() => void refresh())
  useEventListener(window, 'focus', () => void refresh())
  onMounted(refresh)
  onScopeDispose(() => {
    active = false
    requestVersion++
    stopProviders()
    stopExtensions()
  })
  return {
    candidates,
    ocrEnabled,
    ocrConfigured: computed(() => Boolean(draft.value.ocrService)),
    loading: computed(() => loading.value || !initialized.value),
    failed,
    savingOperations: computed(() => savingOperations.value),
    failedOperations: computed(() => failedOperations.value),
    refresh,
    change,
    changeOcrEnabled,
    inherit,
    retry,
    legacy,
    policy: (operation: 'understand' | 'generate'): ImagePolicy => draft.value[operation] ?? { mode: 'native', target: null, fallbacks: [] },
  }
}
