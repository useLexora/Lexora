import type { JSONContent } from '@tiptap/core'
import type { ChatComposerEditorOptions } from './typing'
import { resolveBuddyQuoteReference } from '@buddy-shared/conversation/buddyInputMaterial'
import { appendBuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import Placeholder from '@tiptap/extension-placeholder'
import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { useEditor } from '@tiptap/vue-3'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { chatComposerDocumentToUserContent, createChatComposerContentFromText, findChatComposerTrigger, getChatComposerResourceIds, serializeChatComposerContent, shouldSubmitChatComposerKey } from '@/modules/prompt-input'
import { CHAT_COMPOSER_CLIPBOARD_TYPE, ChatComposerActorReference, ChatComposerDocument, ChatComposerPromptDirective, ChatComposerQuoteReference, ChatComposerResourceClipboard, ChatComposerResourceReference, ChatComposerSessionReference, dispatchComposerEdit, moveChatComposerResourceSelection, replaceChatComposerDocument } from '@/modules/prompt-input/ui'
import { resolveFileIcon } from '@/shared/ui/file-icon'
import { readReferenceClipboard } from '@/shared/ui/selection/referenceClipboard'
import { getChatImageLabels } from '../../model/attachments/chatAttachmentView'
import { shouldAttachPastedText } from '../../model/composer/pastedText'
import { inputMaterialLabel } from '../../model/materials/inputMaterialView'
import { parseSessionReferenceClipboard } from '../../model/sessionReferenceClipboard'

export function useChatComposerEditor(options: ChatComposerEditorOptions) {
  const { t } = useBuddyI18n(options.language)
  const contentJSON = shallowRef(resolveComposerContent(options.composerContent.value, options.draft.value))
  const serializedContent = computed(() => serializeChatComposerContent(contentJSON.value))
  const resourceById = computed(() => new Map(options.resources.value.map(entry => [entry.resource.resourceId, entry.resource])))
  const imageLabels = computed(() => getChatImageLabels(getChatComposerResourceIds(contentJSON.value)
    .flatMap(id => resourceById.value.get(id) ?? [])))
  const quotePasteLimitReached = shallowRef(false)
  const quotePasteLimitMessage = computed(() => quotePasteLimitReached.value ? t('desktop.chat.quoteLimit') : null)
  watch(options.draftId, () => {
    quotePasteLimitReached.value = false
  }, { flush: 'sync' })
  let isComposing = false
  let isHydrating = false

  const editor = useEditor({
    editable: !options.isSending.value,
    content: contentJSON.value,
    extensions: [
      StarterKit.configure({
        document: false,
        bold: false,
        italic: false,
        underline: false,
        blockquote: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        link: false,
        listItem: false,
        orderedList: false,
        strike: false,
      }),
      Placeholder.configure({ placeholder: () => t('chat.composerPlaceholder') }),
      ChatComposerPromptDirective,
      ChatComposerDocument,
      ChatComposerResourceReference.configure({
        resourcePresentation: (id) => {
          const name = resourceById.value.get(id)?.name ?? 'file'
          const imageLabel = imageLabels.value.get(id)
          const iconName = resolveFileIcon(name)
          return {
            iconName,
            iconUrl: '',
            isImage: Boolean(imageLabel),
            label: imageLabel ?? `@${name}`,
            text: imageLabel ?? `@${name}`,
          }
        },
      }),
      ChatComposerSessionReference,
      ChatComposerQuoteReference.configure({
        label: (reference) => {
          const material = resolveBuddyQuoteReference(chatComposerDocumentToUserContent(contentJSON.value), reference)
          return `@${material && material.kind !== 'resource' ? inputMaterialLabel(material, options.language.value) : t('desktop.chat.quoteSelection')}`
        },
      }),
      ChatComposerActorReference,
      ChatComposerResourceClipboard.configure({
        draftId: () => options.draftId.value,
        rejectedIds: options.rejectedResourceIds,
      }),
    ],
    editorProps: {
      attributes: {
        'aria-label': t('desktop.chat.messageInput'),
        'class': 'desktop-chat-composer__prosemirror',
        'data-lexora-composer': '',
        'spellcheck': 'false',
      },
      handleKeyDown: (_view, event) => handleEditorKeydown(event),
      handlePaste: (_view, event) => handleEditorPaste(event),
      handleClickOn: (_view, _position, node, _nodePosition, _event, direct) => {
        if (direct && node.type.name === 'chatResourceReference')
          options.onLocateResource?.(node.attrs.resourceId)
        if (direct && node.type.name === 'chatQuoteReference')
          options.onLocateQuote?.({ type: 'quote_ref', quoteId: node.attrs.quoteId, quoteKind: node.attrs.quoteKind })
        return false
      },
      handleDOMEvents: {
        compositionend: () => {
          isComposing = false
          queueMicrotask(refreshActiveTrigger)
          return false
        },
        compositionstart: () => {
          isComposing = true
          options.onTrigger(null)
          return false
        },
      },
    },
    onBlur: () => { options.onTrigger(null) },
    onFocus: refreshActiveTrigger,
    onSelectionUpdate: refreshActiveTrigger,
    onUpdate: ({ editor }) => {
      quotePasteLimitReached.value = false
      const nextContent = normalizeComposerContent(editor.getJSON())
      contentJSON.value = nextContent
      refreshActiveTrigger()
      if (!isHydrating)
        options.onUpdateContent(serializedContent.value.content, nextContent)
    },
  })

  watch(options.isSending, locked => editor.value?.setEditable(!locked, false))
  watch(() => [...options.rejectedResourceIds()], () => {
    const current = editor.value
    if (current)
      current.view.dispatch(current.state.tr)
  }, { flush: 'sync' })

  watch(
    [options.draft, options.composerContent],
    ([draft, composerContent]) => {
      if (
        draft === serializedContent.value.content
        && JSON.stringify(composerContent) === JSON.stringify(contentJSON.value)
      ) {
        return
      }

      const nextContent = resolveComposerContent(composerContent, draft)
      const current = editor.value
      if (current) {
        const document = current.schema.nodeFromJSON(nextContent)
        const bodyChanged = !current.state.doc.content.eq(document.content)
        const panelResourceIds: string[] = current.state.doc.attrs.panelResourceIds
        const nextPanelResourceIds: string[] = document.attrs.panelResourceIds
        const panelChanged = panelResourceIds.length !== nextPanelResourceIds.length
          || panelResourceIds.some((id, index) => id !== nextPanelResourceIds[index])
        const quotesChanged = JSON.stringify(current.state.doc.attrs.quotes) !== JSON.stringify(document.attrs.quotes)
          || JSON.stringify(current.state.doc.attrs.resourceQuotes) !== JSON.stringify(document.attrs.resourceQuotes)
        const sessionReferencesChanged = JSON.stringify(current.state.doc.attrs.sessionReferences) !== JSON.stringify(document.attrs.sessionReferences)
        if (!bodyChanged && !panelChanged && !quotesChanged && !sessionReferencesChanged)
          return
      }

      isHydrating = true
      try {
        contentJSON.value = nextContent
        if (current) {
          const document = current.schema.nodeFromJSON(nextContent)
          const bodyChanged = !current.state.doc.content.eq(document.content)
          const transaction = current.state.tr
          if (bodyChanged)
            transaction.replaceWith(0, current.state.doc.content.size, document.content)
          transaction
            .setDocAttribute('panelResourceIds', document.attrs.panelResourceIds)
            .setDocAttribute('quotes', document.attrs.quotes)
            .setDocAttribute('resourceQuotes', document.attrs.resourceQuotes)
            .setDocAttribute('sessionReferences', document.attrs.sessionReferences)
          if (isQuoteInsertion(current.getJSON(), nextContent))
            replaceChatComposerDocument(current, chatComposerDocumentToUserContent(nextContent))
          else
            current.view.dispatch(transaction.setMeta('addToHistory', false))
        }
        options.onTrigger(null)
      }
      finally {
        isHydrating = false
      }
    },
  )

  function handleEditorKeydown(event: KeyboardEvent) {
    if (options.onSuggestionKeydown(event))
      return true

    const selection = editor.value?.state.selection
    if (selection instanceof NodeSelection && selection.node.type.name === 'chatResourceReference' && shouldSubmitChatComposerKey(event)) {
      event.preventDefault()
      options.onLocateResource?.(selection.node.attrs.resourceId)
      return true
    }
    if (selection instanceof NodeSelection && selection.node.type.name === 'chatQuoteReference' && shouldSubmitChatComposerKey(event)) {
      event.preventDefault()
      options.onLocateQuote?.({ type: 'quote_ref', quoteId: selection.node.attrs.quoteId, quoteKind: selection.node.attrs.quoteKind })
      return true
    }

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
      && moveChatComposerResourceSelection(
        editor.value!,
        event.key === 'ArrowLeft' ? -1 : 1,
      )
    ) {
      event.preventDefault()
      return true
    }

    if (event.key === 'Enter' && event.shiftKey && !event.isComposing) {
      event.preventDefault()
      editor.value?.chain().focus().setHardBreak().scrollIntoView().run()
      return true
    }
    if (!shouldSubmitChatComposerKey(event))
      return false

    event.preventDefault()
    options.onSubmit()
    return true
  }

  function handleEditorPaste(event: ClipboardEvent) {
    quotePasteLimitReached.value = false
    const reference = readReferenceClipboard(event.clipboardData?.getData('text/html') ?? '')
    if (reference && editor.value && !editor.value.isDestroyed && editor.value.isEditable) {
      const content = chatComposerDocumentToUserContent(editor.value.getJSON())
      const appended = appendBuddyResourceQuote(content, reference)
      if (appended.result === 'added') {
        event.preventDefault()
        dispatchComposerEdit(editor.value, editor.value.state.tr
          .setDocAttribute('resourceQuotes', appended.content.resourceQuotes)
          .replaceSelectionWith(editor.value.schema.nodes.chatQuoteReference!.create({ quoteId: reference.id, quoteKind: 'resource' })))
        return true
      }
      if (appended.result === 'limit') {
        event.preventDefault()
        quotePasteLimitReached.value = true
        return true
      }
      if (appended.result === 'duplicate') {
        event.preventDefault()
        return true
      }
    }
    const clipboardText = event.clipboardData?.getData('text/plain')
    if (clipboardText) {
      const parsed = parseSessionReferenceClipboard(clipboardText)
      if (parsed) {
        event.preventDefault()
        options.onPasteSessionReferences(parsed.references, parsed.text)
        return true
      }
    }
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length) {
      event.preventDefault()
      options.onPasteFiles(files)
      return true
    }
    if (options.pasteTextAsAttachment.value && clipboardText && !event.clipboardData?.getData(CHAT_COMPOSER_CLIPBOARD_TYPE) && shouldAttachPastedText(clipboardText)) {
      event.preventDefault()
      options.onPasteText(clipboardText)
      return true
    }
    return false
  }

  function refreshActiveTrigger() {
    const currentEditor = editor.value
    if (
      !currentEditor
      || options.isSending.value
      || isComposing
      || !currentEditor.isFocused
      || !currentEditor.state.selection.empty
    ) {
      options.onTrigger(null)
      return
    }

    const { from } = currentEditor.state.selection
    options.onTrigger(findChatComposerTrigger(
      currentEditor.state.doc.textBetween(0, from, '\n', '\n'),
    ))
  }

  return { contentJSON, editor, imageLabels, serializedContent, quotePasteLimitMessage }
}

function resolveComposerContent(
  value: JSONContent,
  fallback: string,
): JSONContent {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JSONContent
    : createChatComposerContentFromText(fallback)
}

function normalizeComposerContent(value: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(value)) as JSONContent
}

function isQuoteInsertion(previous: JSONContent, next: JSONContent): boolean {
  const before = chatComposerDocumentToUserContent(previous)
  const after = chatComposerDocumentToUserContent(next)
  const oldQuotes = new Set([
    ...(before.quotes ?? []).map(quote => `message:${quote.id}`),
    ...(before.resourceQuotes ?? []).map(quote => `resource:${quote.id}`),
  ])
  const added = new Set([
    ...(after.quotes ?? []).map(quote => `message:${quote.id}`),
    ...(after.resourceQuotes ?? []).map(quote => `resource:${quote.id}`),
  ].filter(key => !oldQuotes.has(key)))
  if (!added.size)
    return false
  const retained = {
    ...after,
    quotes: after.quotes?.filter(quote => !added.has(`message:${quote.id}`)),
    resourceQuotes: after.resourceQuotes?.filter(quote => !added.has(`resource:${quote.id}`)),
    body: after.body.map(paragraph => ({ ...paragraph, content: paragraph.content.filter(node => node.type !== 'quote_ref' || !added.has(`${node.quoteKind}:${node.quoteId}`)) })),
  }
  return JSON.stringify([before.body, before.panelResourceIds, before.quotes ?? [], before.resourceQuotes ?? [], before.sessionReferences ?? []]) === JSON.stringify([retained.body, retained.panelResourceIds, retained.quotes ?? [], retained.resourceQuotes ?? [], retained.sessionReferences ?? []])
}
