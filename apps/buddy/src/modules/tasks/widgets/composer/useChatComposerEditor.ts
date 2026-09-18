import type { JSONContent } from '@tiptap/core'
import type { ChatComposerEditorOptions } from './typing'
import Placeholder from '@tiptap/extension-placeholder'
import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { useEditor } from '@tiptap/vue-3'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createChatComposerContentFromText, findChatComposerTrigger, getChatComposerResourceIds, serializeChatComposerContent, shouldSubmitChatComposerKey } from '@/modules/prompt-input'
import { ChatComposerDocument, ChatComposerPromptDirective, ChatComposerResourceClipboard, ChatComposerResourceReference, moveChatComposerResourceSelection } from '@/modules/prompt-input/ui'
import { resolveFileIcon } from '@/shared/ui/file-icon'
import { getChatImageLabels } from '../../model/attachments/chatAttachmentView'

export function useChatComposerEditor(options: ChatComposerEditorOptions) {
  const { t } = useBuddyI18n(options.language)
  const contentJSON = shallowRef(resolveComposerContent(options.composerContent.value, options.draft.value))
  const serializedContent = computed(() => serializeChatComposerContent(contentJSON.value))
  const resourceById = computed(() => new Map(options.resources.value.map(entry => [entry.resource.resourceId, entry.resource])))
  const imageLabels = computed(() => getChatImageLabels(getChatComposerResourceIds(contentJSON.value)
    .flatMap(id => resourceById.value.get(id) ?? [])))
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
        if (!bodyChanged && !panelChanged && !quotesChanged)
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
          current.view.dispatch(transaction
            .setDocAttribute('panelResourceIds', document.attrs.panelResourceIds)
            .setDocAttribute('quotes', document.attrs.quotes)
            .setMeta('addToHistory', false))
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
    const files = [...(event.clipboardData?.files ?? [])]
    if (!files.length)
      return false

    event.preventDefault()
    options.onPasteFiles(files)
    return true
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

  return { contentJSON, editor, imageLabels, serializedContent }
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
