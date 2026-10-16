import type { Editor } from '@tiptap/core'
import type { ComputedRef, ShallowRef } from 'vue'
import type { EditorDocumentRange } from './editorRange'
import type {
  EditorRangeReferenceAnchor,
  EditorRangeReferenceElement,
} from './editorRangeReference'
import type { SelectionPanelOpenIntent } from './selectionPanelOpenPolicy'
import { getMarkRange } from '@tiptap/core'
import { computed, shallowRef } from 'vue'
import { getCurrentBlock } from '../../commands/currentBlock'
import {
  clearPanelSelectionHighlight,
  setPanelSelectionHighlight,
} from '../../extensions/PanelSelectionHighlight'
import { selectEditorRange } from './editorRange'
import {
  createEditorRangeReferenceAnchor,
  createEditorRangeReferenceElement,
} from './editorRangeReference'
import {
  applyLinkToSelection,
  exitLinkMarkAtPosition,
  insertEmptyBlockLink,
  removeLinkFromSelection,
  replaceExistingLink,
  restoreLinkSelection,
} from './linkEditorCommands'
import { normalizeLinkHref } from './linkHref'
import { resolveExistingLinkDraftCommit } from './linkPanelDraft'
import { resolveSelectionPanelOpenPolicy } from './selectionPanelOpenPolicy'

type EditorResolver = () => Editor | null | undefined
export type LinkPanelMode = 'selection' | 'empty-block' | 'existing-link'

interface UseLinkPanelOptions {
  onClosed?: () => void
  onOpened?: () => void
}

export interface LinkPanelController {
  isOpen: ShallowRef<boolean>
  mode: ShallowRef<LinkPanelMode>
  canRemove: ShallowRef<boolean>
  linkText: ShallowRef<string>
  linkUrl: ShallowRef<string>
  shouldFocusInputOnOpen: ShallowRef<boolean>
  isConfirmDisabled: ComputedRef<boolean>
  getReferencedVirtualElement: () => EditorRangeReferenceElement | null
  openSelection: (intent?: SelectionPanelOpenIntent) => void
  openEmptyBlock: () => void
  toggle: () => void
  dismiss: () => void
  cancel: () => void
  apply: () => void
  highlightLinkedText: () => void
  remove: () => void
  updateLinkText: (value: string) => void
  updateLinkUrl: (value: string) => void
}

export function useLinkPanel(
  getEditor: EditorResolver,
  options: UseLinkPanelOptions = {},
): LinkPanelController {
  const isOpen = shallowRef(false)
  const mode = shallowRef<LinkPanelMode>('selection')
  const canRemove = shallowRef(false)
  const linkText = shallowRef('')
  const linkUrl = shallowRef('')
  const shouldFocusInputOnOpen = shallowRef(true)
  const initialLinkText = shallowRef('')
  const initialLinkUrl = shallowRef('')
  const selectionRange = shallowRef<EditorDocumentRange | null>(null)
  const emptyBlockRange = shallowRef<EditorDocumentRange | null>(null)
  const referenceAnchor = shallowRef<EditorRangeReferenceAnchor | null>(null)
  const normalizedLinkUrl = computed(() => normalizeLinkHref(linkUrl.value))
  const existingLinkDraftCommit = computed(() => resolveExistingLinkDraftCommit({
    initialHref: initialLinkUrl.value,
    initialText: initialLinkText.value,
    linkText: linkText.value,
    linkUrl: linkUrl.value,
    normalizedHref: normalizedLinkUrl.value,
  }))
  const isConfirmDisabled = computed(() => {
    if (mode.value === 'selection') {
      return !normalizedLinkUrl.value
    }

    if (mode.value === 'existing-link') {
      return !existingLinkDraftCommit.value
    }

    return !normalizedLinkUrl.value || linkText.value.trim().length === 0
  })

  function getEditorInstance() {
    return getEditor()
  }

  function rememberSelection(editor: Editor, range?: EditorDocumentRange | null) {
    const { from, to } = editor.state.selection
    selectionRange.value = range ?? { from, to }
  }

  function rememberEmptyBlockRange(editor: Editor) {
    const currentBlock = getCurrentBlock(editor.state.selection)

    emptyBlockRange.value = currentBlock
      ? {
          from: currentBlock.from,
          to: currentBlock.to,
        }
      : null
  }

  function finalizeClose(notifyClosed = true) {
    const editor = getEditorInstance()

    if (editor) {
      clearPanelSelectionHighlight(editor)
    }

    isOpen.value = false
    canRemove.value = false
    selectionRange.value = null
    emptyBlockRange.value = null
    referenceAnchor.value = null
    linkText.value = ''
    linkUrl.value = ''
    shouldFocusInputOnOpen.value = true
    initialLinkText.value = ''
    initialLinkUrl.value = ''

    if (notifyClosed) {
      options.onClosed?.()
    }
  }

  function openSelection(intent: SelectionPanelOpenIntent = {}) {
    const editor = getEditorInstance()

    if (!editor) {
      return
    }

    const href = editor.getAttributes('link').href
    const isExistingLink = editor.isActive('link') || Boolean(href)
    const openPolicy = resolveSelectionPanelOpenPolicy(intent)
    const linkRange = isExistingLink ? getCurrentLinkRange(editor) : null
    const selectionRangeTarget = linkRange ?? editor.state.selection
    const nextSelectionRange = {
      from: selectionRangeTarget.from,
      to: selectionRangeTarget.to,
    }

    mode.value = isExistingLink ? 'existing-link' : 'selection'
    linkText.value = isExistingLink
      ? editor.state.doc.textBetween(nextSelectionRange.from, nextSelectionRange.to, '\n')
      : ''
    linkUrl.value = typeof href === 'string' && href ? href : ''
    shouldFocusInputOnOpen.value = openPolicy.focusInput
    initialLinkText.value = linkText.value
    initialLinkUrl.value = linkUrl.value
    canRemove.value = isExistingLink
    rememberSelection(editor, linkRange)
    referenceAnchor.value = createEditorRangeReferenceAnchor(editor, nextSelectionRange)

    if (mode.value === 'selection' || (mode.value === 'existing-link' && openPolicy.selectRange)) {
      setPanelSelectionHighlight(editor, nextSelectionRange)
    }
    else {
      clearPanelSelectionHighlight(editor)
    }

    if (mode.value === 'existing-link' && openPolicy.selectRange) {
      selectEditorRange(editor, nextSelectionRange)
    }

    isOpen.value = true
    options.onOpened?.()
  }

  function openEmptyBlock() {
    const editor = getEditorInstance()

    if (!editor) {
      return
    }

    mode.value = 'empty-block'
    linkText.value = ''
    linkUrl.value = ''
    shouldFocusInputOnOpen.value = true
    initialLinkText.value = ''
    initialLinkUrl.value = ''
    canRemove.value = false
    referenceAnchor.value = null
    clearPanelSelectionHighlight(editor)
    rememberSelection(editor)
    rememberEmptyBlockRange(editor)
    isOpen.value = true
    options.onOpened?.()
  }

  function cancel() {
    const editor = getEditorInstance()

    if (editor && mode.value === 'selection') {
      restoreLinkSelection(editor, selectionRange.value)
    }

    if (editor && mode.value === 'existing-link') {
      commitExistingLinkDraft(editor)
    }

    finalizeClose()
  }

  function toggle() {
    if (isOpen.value) {
      cancel()
      return
    }

    openSelection()
  }

  function dismiss() {
    const editor = getEditorInstance()

    if (editor && mode.value === 'existing-link') {
      commitExistingLinkDraft(editor)
    }

    finalizeClose(false)
  }

  function apply() {
    if (isConfirmDisabled.value) {
      return
    }

    const editor = getEditorInstance()

    if (!editor) {
      return
    }

    if (mode.value === 'selection') {
      const href = normalizedLinkUrl.value

      if (!href) {
        return
      }

      const collapsePosition = applyLinkToSelection(editor, {
        href,
        range: selectionRange.value,
      })

      finalizeClose()

      if (collapsePosition !== null) {
        exitLinkMarkAtPosition(editor, collapsePosition)
      }

      return
    }

    if (mode.value === 'existing-link') {
      commitExistingLinkDraft(editor)
      finalizeClose()

      return
    }

    const didInsert = insertEmptyBlockLink(editor, {
      href: normalizedLinkUrl.value,
      range: emptyBlockRange.value,
      text: linkText.value.trim(),
    })
    finalizeClose()

    if (didInsert) {
      exitLinkMarkAtPosition(editor, editor.state.selection.from)
    }
  }

  function remove() {
    const editor = getEditorInstance()

    if (!editor) {
      return
    }

    removeLinkFromSelection(editor, selectionRange.value)
    finalizeClose()
  }

  function updateLinkText(value: string) {
    linkText.value = value
  }

  function updateLinkUrl(value: string) {
    linkUrl.value = value
  }

  function highlightLinkedText() {
    const editor = getEditorInstance()

    if (!editor || mode.value !== 'existing-link' || !selectionRange.value) {
      return
    }

    setPanelSelectionHighlight(editor, selectionRange.value)
  }

  function getReferencedVirtualElement(): EditorRangeReferenceElement | null {
    const editor = getEditorInstance()
    const anchor = referenceAnchor.value

    if (!isOpen.value || !editor || !anchor) {
      return null
    }

    return createEditorRangeReferenceElement(editor, anchor)
  }

  function commitExistingLinkDraft(editor: Editor) {
    if (mode.value !== 'existing-link' || isConfirmDisabled.value) {
      return false
    }

    const draftCommit = existingLinkDraftCommit.value

    if (!draftCommit?.changed) {
      return false
    }

    const nextRange = replaceExistingLink(editor, {
      href: draftCommit.href,
      range: selectionRange.value,
      text: draftCommit.text,
    })

    if (!nextRange) {
      return false
    }

    selectionRange.value = nextRange
    setPanelSelectionHighlight(editor, nextRange)

    return true
  }

  return {
    isOpen,
    mode,
    canRemove,
    linkText,
    linkUrl,
    shouldFocusInputOnOpen,
    isConfirmDisabled,
    getReferencedVirtualElement,
    openSelection,
    openEmptyBlock,
    toggle,
    dismiss,
    cancel,
    apply,
    highlightLinkedText,
    remove,
    updateLinkText,
    updateLinkUrl,
  }
}

function getCurrentLinkRange(editor: Editor): EditorDocumentRange | null {
  const linkType = editor.schema.marks.link

  if (!linkType) {
    return null
  }

  const range = getMarkRange(editor.state.selection.$from, linkType)

  return range
    ? {
        from: range.from,
        to: range.to,
      }
    : null
}
