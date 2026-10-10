import type { Editor } from '@tiptap/core'
import type { Ref } from 'vue'
import type { UseChatComposerOptions } from './typing'
import { computed, onScopeDispose, shallowReactive, shallowRef, watch } from 'vue'
import { pasteChatComposerText, restoreChatComposerResourceText } from '@/modules/prompt-input/ui'
import { isPastedTextResource, pastedTextLineCount } from '../../model/composer/pastedText'

export function useComposerPastedText(options: UseChatComposerOptions, editor: Readonly<Ref<Editor | undefined>>, resourceIds: Readonly<Ref<readonly string[]>>) {
  const texts = shallowReactive(new Map<string, string>())
  const failures = shallowReactive(new Set<string>())
  const pending = new Map<string, Promise<string | null>>()
  const selectedId = shallowRef<string | null>(null)
  let session = 0
  let pasteGeneration = 0
  watch(options.pasteTextAsAttachment, () => {
    pasteGeneration += 1
  }, { flush: 'sync' })
  watch(options.draftId, () => {
    session += 1
    selectedId.value = null
    texts.clear()
    failures.clear()
    pending.clear()
  }, { flush: 'sync' })
  onScopeDispose(() => {
    session += 1
  })

  const resources = computed(() => options.resources.value
    .filter(({ resource }) => resource.state === 'ready' && isPastedTextResource(resource) && resourceIds.value.includes(resource.resourceId)))
  const preview = computed(() => {
    const resource = resources.value.find(({ resource }) => resource.resourceId === selectedId.value)?.resource
    return resource ? { resourceId: resource.resourceId, name: resource.name, text: texts.get(resource.resourceId), failed: failures.has(resource.resourceId) } : null
  })
  watch(resources, (entries) => {
    for (const { resource } of entries) {
      if (!texts.has(resource.resourceId) && !failures.has(resource.resourceId))
        void load(resource.resourceId)
    }
    if (!entries.some(({ resource }) => resource.resourceId === selectedId.value))
      selectedId.value = null
  }, { immediate: true })

  function load(resourceId: string): Promise<string | null> {
    if (texts.has(resourceId))
      return Promise.resolve(texts.get(resourceId)!)
    const existing = pending.get(resourceId)
    if (existing)
      return existing
    const currentSession = session
    failures.delete(resourceId)
    const loading = options.readResourceText(resourceId).then((text) => {
      if (session !== currentSession)
        return null
      texts.set(resourceId, text)
      return text
    }).catch(() => {
      if (session === currentSession)
        failures.add(resourceId)
      return null
    }).finally(() => {
      if (session === currentSession)
        pending.delete(resourceId)
    })
    pending.set(resourceId, loading)
    return loading
  }

  function paste(text: string) {
    const current = editor.value
    if (!current?.isEditable || !options.pasteTextAsAttachment.value)
      return
    const currentSession = session
    const generation = pasteGeneration
    void pasteChatComposerText(current, text, async () => {
      const resourceId = await options.importPastedText(text)
      if (session !== currentSession || pasteGeneration !== generation || !resourceId)
        return null
      texts.set(resourceId, text)
      return resourceId
    })
  }

  function open(resourceId: string): boolean {
    if (!resources.value.some(({ resource }) => resource.resourceId === resourceId))
      return false
    selectedId.value = resourceId
    void load(resourceId)
    return true
  }

  function restore() {
    const selected = preview.value
    const current = editor.value
    if (selected?.text === undefined || !current?.isEditable || options.isSending.value)
      return
    if (restoreChatComposerResourceText(current, selected.resourceId, selected.text)) {
      selectedId.value = null
      current.view.focus()
    }
  }

  return {
    close: () => { selectedId.value = null },
    lineCount: (id: string) => texts.has(id) ? pastedTextLineCount(texts.get(id)!) : undefined,
    open,
    paste,
    preview,
    restore,
    retry: () => selectedId.value && load(selectedId.value),
  }
}
