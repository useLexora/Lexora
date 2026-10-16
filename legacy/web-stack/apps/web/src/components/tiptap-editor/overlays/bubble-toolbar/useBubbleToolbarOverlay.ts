import type { Editor } from '@tiptap/core'
import type { ComputedRef } from 'vue'
import type { LinkPreviewController } from '../link-preview/useLinkPreview'
import type { LinkPanelController } from '../shared/useLinkPanel'
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { isImageSelection } from '../../commands/editorActions'
import { hasDocumentAiAnchorPreview } from '../../extensions/DocumentAiDraftPreview'
import { isMathNodeSelection } from '../../extensions/mathematics/mathNodeSelection'
import { useLinkPreview } from '../link-preview/useLinkPreview'
import { useEditorSnapshot } from '../shared/useEditorSnapshot'
import { useLinkPanel } from '../shared/useLinkPanel'
import { usePanelMountGuard } from '../shared/usePanelMountGuard'

const BUBBLE_TOOLBAR_LINK_PANEL_PLUGIN_KEY = 'bubbleToolbarLinkPanel'
const BUBBLE_TOOLBAR_MENU_PLUGIN_KEY = 'bubbleToolbarMenu'
const CARET_NAVIGATION_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
])

/** 选择工具栏浮层显示上下文。 */
export interface BubbleToolbarShouldShowContext {
  /** 编辑器实例 */
  editor: Editor
  /** 选区起点 */
  from: number
  /** 选区终点 */
  to: number
}

/** 选择工具栏浮层控制器。 */
export interface BubbleToolbarOverlayController {
  /** 链接面板控制器 */
  linkPanel: LinkPanelController
  linkPreview: LinkPreviewController
  /** 是否展示工具栏 */
  shouldShowToolbar: (context: BubbleToolbarShouldShowContext) => boolean
  /** 是否展示链接面板 */
  shouldShowLinkPanel: (context: BubbleToolbarShouldShowContext) => boolean
  /** 是否保持链接面板挂载 */
  shouldKeepLinkPanelMounted: ComputedRef<boolean>
}

export function useBubbleToolbarOverlay(editor: Editor): BubbleToolbarOverlayController {
  const editorSnapshot = useEditorSnapshot(editor)
  const linkPanel = useLinkPanel(() => editor, {
    onClosed: hideLinkPanelMenu,
    onOpened: showLinkPanelMenu,
  })
  const linkPreview = useLinkPreview(editor, linkPanel)
  const pendingKeyboardCaretNavigation = shallowRef(false)
  let selectionOverlayHiddenForDocumentAi = false
  const shouldKeepLinkPanelMounted = computed(() => {
    void editorSnapshot.value

    const { from, to } = editor.state.selection
    return !shouldHideSelectionOverlayForDocumentAi()
      && (from !== to || editor.isActive('link'))
      && !isImageSelection(editor)
  })

  usePanelMountGuard(linkPanel, shouldKeepLinkPanelMounted)

  watch(editorSnapshot, openExistingLinkPanelAfterKeyboardNavigation)
  watch(editorSnapshot, syncDocumentAiSelectionOverlayVisibility)

  onMounted(() => {
    const editorElement = editor.view?.dom

    if (!editorElement) {
      return
    }

    editorElement.addEventListener('keydown', handleEditorKeydown)
    editorElement.addEventListener('pointerdown', handleEditorPointerDown)
  })

  onBeforeUnmount(() => {
    const editorElement = editor.view?.dom

    if (!editorElement) {
      return
    }

    editorElement.removeEventListener('keydown', handleEditorKeydown)
    editorElement.removeEventListener('pointerdown', handleEditorPointerDown)
  })

  return {
    linkPanel,
    linkPreview,
    shouldShowToolbar,
    shouldShowLinkPanel,
    shouldKeepLinkPanelMounted,
  }

  function shouldShowToolbar({ from, to }: BubbleToolbarShouldShowContext): boolean {
    if (shouldHideSelectionOverlayForDocumentAi()) {
      return false
    }

    if (isMathNodeSelection(editor.state)) {
      return false
    }

    if (linkPanel.isOpen.value) {
      return false
    }

    if (from === to && editor.isActive('link')) {
      return false
    }

    return isImageSelection(editor) || from !== to
  }

  function shouldShowLinkPanel({ from, to }: BubbleToolbarShouldShowContext): boolean {
    return Boolean(
      !shouldHideSelectionOverlayForDocumentAi()
      && linkPanel.isOpen.value
      && !isImageSelection(editor)
      && (from !== to || editor.isActive('link')),
    )
  }

  function dispatchBubbleMenuMeta(pluginKey: string, meta: 'hide' | 'show' | 'updatePosition') {
    const view = editor.view

    if (editor.isDestroyed || !view) {
      return
    }

    view.dispatch(editor.state.tr.setMeta(pluginKey, meta))
  }

  function dispatchLinkPanelMenuMeta(meta: 'hide' | 'show' | 'updatePosition') {
    dispatchBubbleMenuMeta(BUBBLE_TOOLBAR_LINK_PANEL_PLUGIN_KEY, meta)
  }

  function hideSelectionOverlayMenus() {
    dispatchBubbleMenuMeta(BUBBLE_TOOLBAR_MENU_PLUGIN_KEY, 'hide')
    dispatchLinkPanelMenuMeta('hide')
  }

  function showLinkPanelMenu() {
    void nextTick(() => {
      dispatchLinkPanelMenuMeta('show')

      if (typeof window === 'undefined') {
        dispatchLinkPanelMenuMeta('updatePosition')
        return
      }

      window.requestAnimationFrame(() => dispatchLinkPanelMenuMeta('updatePosition'))
    })
  }

  function hideLinkPanelMenu() {
    void nextTick(() => dispatchLinkPanelMenuMeta('hide'))
  }

  function handleEditorKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !CARET_NAVIGATION_KEYS.has(event.key)) {
      return
    }

    pendingKeyboardCaretNavigation.value = true
  }

  function handleEditorPointerDown() {
    pendingKeyboardCaretNavigation.value = false
  }

  function openExistingLinkPanelAfterKeyboardNavigation() {
    if (!pendingKeyboardCaretNavigation.value) {
      return
    }

    pendingKeyboardCaretNavigation.value = false

    if (linkPanel.isOpen.value || isImageSelection(editor) || isMathNodeSelection(editor.state)) {
      return
    }

    if (shouldHideSelectionOverlayForDocumentAi()) {
      return
    }

    const { from, to } = editor.state.selection

    if (from !== to || !editor.isActive('link')) {
      return
    }

    linkPanel.openSelection({
      source: 'keyboard-caret-navigation',
    })
  }

  function syncDocumentAiSelectionOverlayVisibility() {
    if (!shouldHideSelectionOverlayForDocumentAi()) {
      selectionOverlayHiddenForDocumentAi = false
      return
    }

    if (selectionOverlayHiddenForDocumentAi) {
      return
    }

    selectionOverlayHiddenForDocumentAi = true
    hideSelectionOverlayMenus()
  }

  function shouldHideSelectionOverlayForDocumentAi() {
    const editorElement = editor.view?.dom
    const activeElement = editorElement?.ownerDocument.activeElement
    const editorHasDomFocus = Boolean(
      editorElement
      && activeElement
      && editorElement.contains(activeElement),
    )

    return hasDocumentAiAnchorPreview(editor.state) && !editorHasDomFocus
  }
}
