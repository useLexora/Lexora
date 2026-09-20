import type { UseChatComposerOptions } from './typing'
import type { ChatComposerContextOptions, ChatComposerTrigger, ChatPromptContextOption } from '@/modules/prompt-input'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createChatComposerSourceOptions, createChatComposerSuggestions, getChatComposerResourceIds, shouldSubmitChatComposerKey } from '@/modules/prompt-input'

export function useChatComposerSuggestions(
  options: Pick<UseChatComposerOptions, 'composerContent' | 'draftId' | 'language' | 'loadContextOptions' | 'resources'>,
  onSelect: (option: ChatPromptContextOption | undefined, action?: 'complete' | 'select') => void,
  getImageLabel: (resourceId: string) => string | undefined,
) {
  const { t } = useBuddyI18n(options.language)
  const contextOptions = shallowRef<ChatComposerContextOptions>({ files: [], skills: [] })
  const activeTrigger = shallowRef<ChatComposerTrigger | null>(null)
  const activeSuggestionIndex = shallowRef(0)
  const isLoadingContext = shallowRef(false)
  const contextLoadFailed = shallowRef(false)
  const deepSearch = shallowRef(false)
  let contextRequestId = 0
  let loadedSkillDraftId: string | null = null

  const fileQuery = shallowRef('')
  const currentOptions = computed<ChatPromptContextOption[]>(() => {
    const resources = new Map(options.resources.value.map(({ resource }) => [resource.resourceId, resource]))
    return getChatComposerResourceIds(options.composerContent.value).flatMap((id) => {
      const resource = resources.get(id)
      return resource?.draftId === options.draftId.value && resource.state === 'ready'
        ? [{
            category: 'current',
            description: resource.localReference?.path ?? resource.sourcePath ?? null,
            entryKind: resource.kind === 'directory' ? 'directory' : 'file',
            fileName: resource.name,
            fileMetadata: { mimeType: resource.mimeType, sizeBytes: resource.sizeBytes, nameSource: resource.nameSource },
            kind: 'file',
            label: getImageLabel(resource.resourceId) ?? resource.name,
            path: resource.localReference?.path ?? null,
            resourceId: resource.resourceId,
            value: resource.resourceId,
          }]
        : []
    })
  })
  const sourceOptions = computed(() => [...createChatComposerSourceOptions(currentOptions.value, fileQuery.value), ...createChatComposerSourceOptions(contextOptions.value.files)])
  const suggestions = computed(() => createChatComposerSuggestions(activeTrigger.value, { ...contextOptions.value, files: sourceOptions.value }, key => t(key)))

  function invalidateQuery() {
    contextRequestId += 1
    isLoadingContext.value = false
  }

  watch(activeTrigger, (trigger) => {
    activeSuggestionIndex.value = 0
    if (!trigger || trigger.kind === 'slash') {
      deepSearch.value = false
      loadedSkillDraftId = null
      invalidateQuery()
      return
    }
    if (trigger.kind !== 'mention')
      deepSearch.value = false
    const draftId = options.draftId.value
    const reusesSkillCatalog = trigger.kind === 'skill' && loadedSkillDraftId === draftId
    if (reusesSkillCatalog && !contextLoadFailed.value)
      return
    loadedSkillDraftId = trigger.kind === 'skill' ? draftId : null
    void loadContextOptions(trigger.kind === 'mention' ? trigger.query : null)
  }, { flush: 'sync' })
  watch(options.draftId, () => {
    activeTrigger.value = null
    contextOptions.value = { files: [], skills: [] }
    loadedSkillDraftId = null
    invalidateQuery()
  }, { flush: 'sync' })
  onScopeDispose(invalidateQuery)

  async function loadContextOptions(query: string | null): Promise<void> {
    const requestId = ++contextRequestId
    const directory = query === fileQuery.value ? contextOptions.value.directory : undefined
    fileQuery.value = query ?? ''
    isLoadingContext.value = true
    contextLoadFailed.value = false
    contextOptions.value = { files: [], skills: [], directory }
    try {
      const context = await options.loadContextOptions(query, deepSearch.value)
      if (requestId === contextRequestId)
        contextOptions.value = context
    }
    catch {
      if (requestId === contextRequestId) {
        contextLoadFailed.value = true
        contextOptions.value = { files: [], skills: [] }
      }
    }
    finally {
      if (requestId === contextRequestId)
        isLoadingContext.value = false
    }
  }

  function setDeepSearch(value: boolean) {
    if (activeTrigger.value?.kind !== 'mention')
      return
    deepSearch.value = value
    activeSuggestionIndex.value = 0
    void loadContextOptions(activeTrigger.value.query)
  }

  function handleKeydown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229)
      return false
    if (event.key === 'Escape' && activeTrigger.value) {
      event.preventDefault()
      activeTrigger.value = null
      return true
    }
    if (!suggestions.value.length) {
      if (activeTrigger.value?.kind === 'mention' && shouldSubmitChatComposerKey(event)) {
        event.preventDefault()
        return true
      }
      return false
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      activeSuggestionIndex.value = (activeSuggestionIndex.value + delta + suggestions.value.length) % suggestions.value.length
      return true
    }
    if ((event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) || shouldSubmitChatComposerKey(event)) {
      event.preventDefault()
      onSelect(suggestions.value[activeSuggestionIndex.value]?.option, event.key === 'Tab' ? 'complete' : 'select')
      return true
    }
    return false
  }

  return {
    activeSuggestionIndex,
    activeTrigger,
    closeSuggestions: () => { activeTrigger.value = null },
    contextOptions,
    contextLoadFailed,
    deepSearch,
    setDeepSearch,
    handleKeydown,
    isLoadingContext,
    loadContextOptions,
    sourceOptions,
    suggestions,
  }
}
