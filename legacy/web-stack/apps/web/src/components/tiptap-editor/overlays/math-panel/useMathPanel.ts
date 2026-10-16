import type { Editor, EditorEvents } from '@tiptap/core'
import type { ComputedRef, ShallowRef } from 'vue'
import type { MathNodeMode, SelectedMathNode } from '../../extensions/mathematics/mathNodeSelection'
import { Selection } from '@tiptap/pm/state'
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import {
  getSelectedMathNode,
  TIPTAP_MATH_PANEL_OPEN_META,
} from '../../extensions/mathematics/mathNodeSelection'
import { useEditorSnapshot } from '../shared/useEditorSnapshot'

export interface MathPanelController {
  draftLatex: ShallowRef<string>
  isOpen: ShallowRef<boolean>
  mode: ComputedRef<MathNodeMode>
  apply: () => void
  cancel: () => void
  remove: () => void
  shouldShow: () => boolean
  updateDraftLatex: (value: string) => void
}

export function useMathPanel(editor: Editor): MathPanelController {
  const editorSnapshot = useEditorSnapshot(editor)
  const isOpen = shallowRef(false)
  const draftLatex = shallowRef('')
  const dismissedSelectionKey = shallowRef<string | null>(null)
  const selectedMathNode = computed(() => {
    void editorSnapshot.value

    return getSelectedMathNode(editor.state)
  })
  const mode = computed<MathNodeMode>(() => selectedMathNode.value?.mode ?? 'inline')

  watch(
    () => selectedMathNode.value?.key ?? null,
    (key, previousKey) => {
      if (!key) {
        closePanel()
        dismissedSelectionKey.value = null
        return
      }

      if (key !== previousKey) {
        dismissedSelectionKey.value = null
      }

      openSelectedMathNode(false)
    },
    {
      immediate: true,
    },
  )

  onMounted(() => {
    editor.on('transaction', handleEditorTransaction)
  })

  onBeforeUnmount(() => {
    editor.off('transaction', handleEditorTransaction)
  })

  function handleEditorTransaction(event: EditorEvents['transaction']) {
    if (!event.transaction.getMeta(TIPTAP_MATH_PANEL_OPEN_META)) {
      return
    }

    openSelectedMathNode(true)
  }

  function openSelectedMathNode(force: boolean) {
    const selection = selectedMathNode.value

    if (!selection) {
      return
    }

    if (!force && selection.key === dismissedSelectionKey.value) {
      return
    }

    dismissedSelectionKey.value = null
    draftLatex.value = selection.latex
    isOpen.value = true
  }

  function closePanel(selection?: SelectedMathNode) {
    isOpen.value = false

    if (selection) {
      dismissedSelectionKey.value = selection.key
    }
  }

  function apply() {
    const selection = selectedMathNode.value

    if (!selection) {
      return
    }

    updateMathNodeLatex(selection, draftLatex.value)
    closePanel(selection)
    editor.view.focus()
  }

  function cancel() {
    const selection = selectedMathNode.value

    if (!selection) {
      closePanel()
      return
    }

    closePanel(selection)
    editor.view.focus()
  }

  function remove() {
    const selection = selectedMathNode.value

    if (!selection) {
      return
    }

    const transaction = editor.state.tr
      .delete(selection.pos, selection.pos + selection.nodeSize)
      .scrollIntoView()

    editor.view.dispatch(transaction)
    closePanel()
    dismissedSelectionKey.value = null
    editor.view.focus()
  }

  function shouldShow() {
    return isOpen.value && getSelectedMathNode(editor.state) !== null
  }

  function updateDraftLatex(value: string) {
    draftLatex.value = value
  }

  function updateMathNodeLatex(selection: SelectedMathNode, latex: string) {
    const node = editor.state.doc.nodeAt(selection.pos)

    if (!node || node.type.name !== selection.nodeName) {
      return
    }

    const transaction = editor.state.tr.setNodeMarkup(selection.pos, undefined, {
      ...node.attrs,
      latex,
    })
    const nextSelection = Selection.near(
      transaction.doc.resolve(selection.pos + node.nodeSize),
      1,
    )

    transaction
      .setSelection(nextSelection)
      .scrollIntoView()

    editor.view.dispatch(transaction)
  }

  return {
    draftLatex,
    isOpen,
    mode,
    apply,
    cancel,
    remove,
    shouldShow,
    updateDraftLatex,
  }
}
