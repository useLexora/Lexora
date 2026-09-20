import type { BuddyChatCommandName } from '@buddy-shared/conversation/buddyChatCommands'
import type { BuddyMessageQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { JSONContent } from '@tiptap/core'
import type { ComposerResourceCard, UseChatComposerOptions } from './typing'
import type { ChatComposerSubmitPayload, ChatPromptContextOption } from '@/modules/prompt-input'
import { isBuddyRunChatCommand, parseBuddyChatCommand } from '@buddy-shared/conversation/buddyChatCommands'
import { composerReferencePath } from '@buddy-shared/conversation/composerReferencePath'
import { computed, onScopeDispose, watch } from 'vue'
import { CHAT_PROMPT_DIRECTIVE_NODE_NAME, getChatComposerResourceIds, serializeChatComposerContent } from '@/modules/prompt-input'
import { insertChatComposerResources, insertResolvedChatComposerResource, removeChatComposerPanelResource, removeChatComposerResource } from '@/modules/prompt-input/ui'
import { resolveComposerResourcePreviewUrl } from '../../model/attachments/chatAttachmentView'
import { resolveChatComposerModelInputIssue } from '../../model/composer/chatComposerModelCapability'
import { composerParentDirectory } from './chatComposerSourcePresentation'
import { addChatQuote, removeChatQuote } from './chatQuoteEditing'
import { useChatComposerEditor } from './useChatComposerEditor'
import { useChatComposerSuggestions } from './useChatComposerSuggestions'

export function useChatComposer(options: UseChatComposerOptions) {
  let editingSession = 0
  watch(options.draftId, () => {
    editingSession += 1
  }, { flush: 'sync' })
  onScopeDispose(() => {
    editingSession += 1
  })

  const resourceById = computed(() => new Map(options.resources.value.map(entry => [entry.resource.resourceId, entry])))
  const query = useChatComposerSuggestions(options, selectSuggestion, getImageLabel)
  const { editor, contentJSON, imageLabels, serializedContent } = useChatComposerEditor({
    composerContent: options.composerContent,
    draft: options.draft,
    draftId: options.draftId,
    isSending: options.isSending,
    language: options.language,
    rejectedResourceIds: options.rejectedResourceIds,
    resources: options.resources,
    onUpdateContent: options.onUpdateContent,
    onTrigger: (trigger) => { query.activeTrigger.value = trigger },
    onSuggestionKeydown: (event) => {
      const directory = query.contextOptions.value.directory
      if (!event.isComposing && event.keyCode !== 229 && event.key === 'Tab' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && query.activeTrigger.value?.kind === 'mention' && directory) {
        const parent = composerParentDirectory(directory)
        if (parent) {
          event.preventDefault()
          navigateDirectory(parent)
          return true
        }
      }
      return query.handleKeydown(event)
    },
    onPasteFiles: files => attachFiles(files, 'both', 'clipboard'),
    onSubmit: submit,
    onLocateResource: options.onLocateResource,
  })
  const resourceIds = computed(() => getChatComposerResourceIds(contentJSON.value))
  const quotes = computed(() => serializedContent.value.userContent?.quotes ?? [])
  const modelInputIssue = computed(() => resolveChatComposerModelInputIssue({
    model: options.selectedModel.value,
    modelSelection: {
      reasoning: options.selectedEffort.value,
      serviceTier: options.selectedServiceTier.value,
    },
    resourceIds: resourceIds.value,
    resources: options.resources.value,
  }))
  const canSubmit = computed(() => options.canSend.value && modelInputIssue.value === null && (
    serializedContent.value.content.length > 0 || resourceIds.value.length > 0 || quotes.value.length > 0
  ) && resourceIds.value.every(id => resourceById.value.get(id)?.resource.state === 'ready'))
  const panelResources = computed(() => (contentJSON.value.attrs?.panelResourceIds as string[] ?? [])
    .flatMap(id => resourceById.value.get(id) ?? []))
  const resourceStripResources = computed<ComposerResourceCard[]>(() => {
    return resourceIds.value.flatMap((id) => {
      const entry = resourceById.value.get(id)
      return entry
        ? [{
            ...entry,
            imageLabel: imageLabels.value.get(id),
            previewUrl: resolveComposerResourcePreviewUrl(entry.resource),
          }]
        : []
    })
  })

  function getImageLabel(resourceId: string): string | undefined {
    return imageLabels.value.get(resourceId)
  }

  function submit() {
    const current = editor.value
    if (!current?.isEditable)
      return
    const command = parseBuddyChatCommand(serializeChatComposerContent(current.getJSON()).content)
    if (command && !isBuddyRunChatCommand(command.name) && replaceTypedCommand(command.name) && command.name === 'skills')
      return
    const submitted = current.getJSON()
    const serialized = serializeChatComposerContent(submitted)
    if (!canSubmitDocument(serialized, getChatComposerResourceIds(submitted)))
      return
    options.onSend(serialized)
  }

  function canSubmitDocument(
    serialized: ChatComposerSubmitPayload,
    submittedResourceIds: readonly string[],
  ): boolean {
    return options.canSend.value
      && modelInputIssue.value === null
      && Boolean(serialized.content.length || submittedResourceIds.length || serialized.userContent?.quotes?.length)
      && submittedResourceIds.every(id => resourceById.value.get(id)?.resource.state === 'ready')
  }

  function insertCommand(name: BuddyChatCommandName, range: { from: number, to: number }, trailingSpace = false) {
    query.closeSuggestions()
    const content: JSONContent[] = name === 'skills'
      ? [{ type: 'text', text: '$' }]
      : [{
          type: CHAT_PROMPT_DIRECTIVE_NODE_NAME,
          attrs: { directive: 'slash_command', commandMode: name === 'compact' ? 'action' : 'prompt', value: `/${name}` },
        }, ...trailingSpace ? [{ type: 'text', text: ' ' }] : []]
    return editor.value?.chain().focus().insertContentAt(range, content).run() ?? false
  }

  function replaceTypedCommand(name: BuddyChatCommandName): boolean {
    let range: { from: number, to: number } | null = null
    let foundContent = false
    editor.value?.state.doc.descendants((node, position) => {
      if (foundContent || !node.isInline)
        return !foundContent
      if (node.isText && !node.text?.trim())
        return
      foundContent = true
      const match = node.isText ? new RegExp(`^(\\s*)/${name}(?=\\s|$)`, 'i').exec(node.text!) : null
      if (match) {
        const from = position + match[1]!.length
        range = { from, to: from + name.length + 1 }
      }
      return false
    })
    return range ? insertCommand(name, range) : false
  }

  async function resolveSource(source: BuddyComposerSource): Promise<string | null> {
    const session = editingSession
    const resourceId = await options.selectSource(source)
    return session === editingSession ? resourceId : null
  }

  function resolveOption(option: ChatPromptContextOption): Promise<string | null> {
    if (option.resourceId) {
      const resource = resourceById.value.get(option.resourceId)?.resource
      return Promise.resolve(resource?.draftId === options.draftId.value && resource.state === 'ready' && resourceIds.value.includes(resource.resourceId) ? resource.resourceId : null)
    }
    return option.source ? resolveSource(option.source) : Promise.resolve(null)
  }

  function attachFiles(files: readonly File[], placement: 'panel' | 'both', origin: 'file' | 'clipboard' = 'file') {
    const current = editor.value
    if (!current || !current.isEditable)
      return
    insertChatComposerResources(current, options.beginImport(files, origin), placement)
  }

  function removeResource(resourceId: string) {
    const current = editor.value
    if (!current)
      return false
    return removeChatComposerResource(current, resourceId)
  }

  function selectSuggestion(option: ChatPromptContextOption | undefined, action: 'complete' | 'select' = 'select') {
    const currentEditor = editor.value
    const trigger = query.activeTrigger.value
    if (!currentEditor || !currentEditor.isEditable || !trigger || !option)
      return

    const to = currentEditor.state.selection.from
    const from = Math.max(1, to - (trigger.rawQuery ?? trigger.query).length - 1)
    if (action === 'complete' && option.entryKind === 'directory' && option.path) {
      navigateDirectory(option.path)
      return
    }
    if (action === 'complete' && option.kind === 'file' && option.path) {
      const path = composerReferencePath(option.path, query.contextOptions.value.directory?.workingDirectory)
      const text = /[\s"\\]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`
      currentEditor.chain().focus().insertContentAt({ from, to }, { type: 'text', text }).run()
      return
    }
    query.activeTrigger.value = null
    if (option.kind === 'file') {
      void insertResolvedChatComposerResource(currentEditor, { from, to }, () => resolveOption(option))
      return
    }
    const command = option.kind === 'slashCommand' ? parseBuddyChatCommand(option.value) : null
    if (option.kind === 'slashCommand') {
      if (!command)
        return
      if (insertCommand(command.name, { from, to }, true) && isBuddyRunChatCommand(command.name))
        submit()
      return
    }
    currentEditor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({
        type: CHAT_PROMPT_DIRECTIVE_NODE_NAME,
        attrs: { directive: 'skill', value: option.value, skill: option.skill ?? null },
      })
      .insertContent(' ')
      .run()
  }

  function navigateDirectory(path: string) {
    const currentEditor = editor.value
    const trigger = query.activeTrigger.value
    if (!currentEditor || !trigger || trigger.kind !== 'mention')
      return
    const reference = composerReferencePath(path, query.contextOptions.value.directory?.workingDirectory)
    const completion = reference === '.' ? '' : `${reference.replace(/[\\/]+$/u, '')}/`
    const text = /[\s"\\]/u.test(completion) ? `@${JSON.stringify(completion).slice(0, -1)}` : `@${completion}`
    const to = currentEditor.state.selection.from
    const from = Math.max(1, to - (trigger.rawQuery ?? trigger.query).length - 1)
    currentEditor.chain().focus().insertContentAt({ from, to }, { type: 'text', text }).run()
  }

  async function selectPanelSource(option: ChatPromptContextOption): Promise<boolean> {
    const currentEditor = editor.value
    if (!currentEditor || !currentEditor.isEditable || option.kind !== 'file')
      return false
    const resourceId = await resolveOption(option)
    if (!resourceId)
      return false
    return insertChatComposerResources(currentEditor, [resourceId], 'panel')
  }

  return {
    activeSuggestionIndex: query.activeSuggestionIndex,
    activeTrigger: query.activeTrigger,
    attachFiles,
    canSubmit,
    closeSuggestions: query.closeSuggestions,
    contextOptions: query.contextOptions,
    editor,
    isLoadingContext: query.isLoadingContext,
    contextLoadFailed: query.contextLoadFailed,
    loadContextOptions: query.loadContextOptions,
    deepSearch: query.deepSearch,
    setDeepSearch: query.setDeepSearch,
    navigateDirectory,
    modelInputIssue,
    panelResources,
    quotes,
    addQuote: (quote: BuddyMessageQuote) => addChatQuote(editor.value, quote),
    removeQuote: (id: string) => removeChatQuote(editor.value, id),
    removeResource,
    removePanelResource: (id: string) => editor.value && removeChatComposerPanelResource(editor.value, id),
    resourceStripResources,
    selectPanelSource,
    selectSuggestion,
    submit,
    sourceOptions: query.sourceOptions,
    suggestions: query.suggestions,
  }
}
