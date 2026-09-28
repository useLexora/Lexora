import type { LocalSkill, LocalSkillCatalog, SkillDetail, SkillInstallPreview, SkillOrigin } from '@buddy-shared/skills/skillApi'
import type { Ref } from 'vue'
import type { SkillsContext } from '../skillsContext'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useEventListener } from '@vueuse/core'
import { onScopeDispose, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

interface SkillsManagerOptions extends Pick<SkillsContext, 'api' | 'ready' | 'spaces'> {
  language: Readonly<Ref<BuddyLocale>>
}

export function useSkillsManager(context: SkillsManagerOptions, scope: Readonly<Ref<string | null>>, enabled: Readonly<Ref<boolean>> = shallowRef(true)) {
  const catalog = shallowRef<LocalSkillCatalog | null>(null)
  const detail = shallowRef<SkillDetail | null>(null)
  const selectedSkill = shallowRef<LocalSkill | null>(null)
  const detailLoading = shallowRef(false)
  const detailError = shallowRef<string | null>(null)
  const preview = shallowRef<SkillInstallPreview | null>(null)
  const loading = shallowRef(false)
  const busy = shallowRef(false)
  const error = shallowRef<string | null>(null)
  let version = 0
  let loadVersion = 0
  let detailVersion = 0
  let disposed = false

  async function load() {
    if (!enabled.value)
      return
    const current = ++loadVersion
    const spaceId = scope.value
    loading.value = true
    try {
      await context.ready
      const result = await context.api.list(spaceId)
      if (!disposed && current === loadVersion) {
        catalog.value = result
        error.value = null
      }
    }
    catch (reason) {
      if (!disposed && current === loadVersion)
        error.value = resolveLocalChatErrorMessage(reason, context.language.value)
    }
    finally {
      if (!disposed && current === loadVersion)
        loading.value = false
    }
  }

  async function mutate<T>(request: () => Promise<T>, apply: (result: T) => void) {
    if (busy.value)
      return
    const current = version
    loadVersion += 1
    loading.value = false
    busy.value = true
    error.value = null
    try {
      const result = await request()
      if (!disposed && current === version) {
        loadVersion += 1
        loading.value = false
        apply(result)
      }
      else if (result && typeof result === 'object' && 'candidates' in result && 'id' in result) {
        void context.api.discard(String(result.id)).catch(() => {})
      }
    }
    catch (reason) {
      if (!disposed && current === version)
        error.value = resolveLocalChatErrorMessage(reason, context.language.value)
    }
    finally { busy.value = false }
  }

  function closePreview() {
    const id = preview.value?.id
    preview.value = null
    if (id)
      void context.api.discard(id).catch(() => {})
  }

  async function inspect(skill: LocalSkill) {
    const current = ++detailVersion
    const spaceId = scope.value
    selectedSkill.value = skill
    detail.value = null
    detailError.value = null
    detailLoading.value = true
    try {
      const result = await context.api.get({ spaceId, id: skill.id })
      if (!disposed && current === detailVersion)
        detail.value = result
    }
    catch (reason) {
      if (!disposed && current === detailVersion)
        detailError.value = resolveLocalChatErrorMessage(reason, context.language.value)
    }
    finally {
      if (!disposed && current === detailVersion)
        detailLoading.value = false
    }
  }

  function closeDetail() {
    detailVersion += 1
    selectedSkill.value = null
    detail.value = null
    detailError.value = null
    detailLoading.value = false
  }

  function startPreview(source: SkillOrigin | 'directory', updateId?: string) {
    const spaceId = scope.value
    closePreview()
    return mutate(
      () => typeof source === 'string'
        ? context.api.previewLocal({ spaceId, ...(updateId ? { updateId } : {}) })
        : context.api.preview({ spaceId, source, ...(updateId ? { updateId } : {}) }),
      result => preview.value = result,
    )
  }

  function install(candidateIds: readonly string[]) {
    const previewId = preview.value?.id
    if (!previewId)
      return
    return mutate(() => context.api.install({ previewId, candidateIds: [...candidateIds] }), (result) => {
      catalog.value = result
      preview.value = null
      closeDetail()
    })
  }

  function setEnabled(skill: LocalSkill, enabled: boolean) {
    const spaceId = scope.value
    return mutate(() => context.api.setEnabled({ spaceId, id: skill.id, revision: skill.revision, enabled }), result => catalog.value = result)
  }

  function remove(skill: LocalSkill) {
    const spaceId = scope.value
    return mutate(() => context.api.remove({ spaceId, id: skill.id, revision: skill.revision }), (result) => {
      catalog.value = result
      closeDetail()
    })
  }

  function reveal(skill: LocalSkill) {
    const spaceId = scope.value
    return mutate(() => context.api.reveal({ spaceId, id: skill.id }), () => {})
  }

  watch([scope, enabled, () => JSON.stringify(context.spaces.value.find(space => space.id === scope.value)?.primaryDirectory ?? null)], () => {
    version += 1
    loadVersion += 1
    catalog.value = null
    loading.value = false
    closeDetail()
    closePreview()
    void load()
  }, { immediate: true, flush: 'sync' })
  let eventSource: string | undefined
  let lastSequence = 0
  const stop = context.api.onChanged((event) => {
    if (eventSource !== event.sourceId) {
      eventSource = event.sourceId
      lastSequence = 0
    }
    if (event.sequence <= lastSequence)
      return
    lastSequence = event.sequence
    if (event.type === 'catalog' && event.mode === 'discovery')
      return
    if (event.spaceId === null || event.spaceId === scope.value)
      void load()
  })
  if (typeof window !== 'undefined') {
    useEventListener(window, 'focus', () => {
      if (!busy.value)
        void load()
    })
  }
  watch(catalog, (value) => {
    if (!value || !selectedSkill.value)
      return
    const current = value.skills.find(skill => skill.id === selectedSkill.value?.id)
    if (!current) {
      closeDetail()
      return
    }
    if (current.filePath !== selectedSkill.value.filePath || current.revision !== selectedSkill.value.revision) {
      void inspect(current)
      return
    }
    selectedSkill.value = current
    if (detail.value)
      detail.value = { ...detail.value, skill: current }
  })
  onScopeDispose(() => {
    disposed = true
    version += 1
    detailVersion += 1
    loadVersion += 1
    stop()
    closePreview()
  })

  return { catalog, detail, selectedSkill, detailLoading, detailError, preview, busy, loading, error, load, inspect, closeDetail, startPreview, closePreview, install, setEnabled, remove, reveal }
}
