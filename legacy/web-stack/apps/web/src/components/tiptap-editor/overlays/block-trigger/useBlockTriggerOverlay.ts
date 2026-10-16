import type { Editor, EditorEvents } from '@tiptap/core'
import type { ComputedRef, ShallowRef } from 'vue'
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { getCurrentBlock } from '../../commands/currentBlock'
import { resolveBlockTriggerAnchorRect } from './blockTriggerPosition'

export type BlockTriggerPanel = 'root' | 'align' | 'color' | 'link'

const BLOCK_TRIGGER_BUTTON_WIDTH = 40
const BLOCK_TRIGGER_EMPTY_BUTTON_WIDTH = 30
const BLOCK_TRIGGER_BUTTON_HEIGHT = 30
const BLOCK_TRIGGER_BUTTON_GAP = 8
const BLOCK_TRIGGER_HOTSPOT_X_PADDING = 12
const BLOCK_TRIGGER_HOTSPOT_Y_PADDING = 6

/** 块触发菜单浮层控制器 */
export interface BlockTriggerOverlayController {
  visible: ShallowRef<boolean>
  activePanel: ShallowRef<BlockTriggerPanel>
  shouldRenderTriggerMenu: ComputedRef<boolean>
  shouldKeepLinkPanelMounted: ComputedRef<boolean>
  isTriggerButtonVisible: ComputedRef<boolean>
  anchorStyle: ComputedRef<Record<string, string> | undefined>
  canShowTriggerMenu: () => boolean
  openMenu: () => boolean
  openPanel: (panel: Exclude<BlockTriggerPanel, 'root'>) => boolean
  closeMenu: () => void
  handleTriggerMouseEnter: () => void
  handleTriggerMouseLeave: () => void
}

export function useBlockTriggerOverlay(editor: Editor) {
  const visible = shallowRef(false)
  const activePanel = shallowRef<BlockTriggerPanel>('root')
  const isEditorFocused = shallowRef(editor.isFocused)
  const isTriggerHotspotHovered = shallowRef(false)
  const isTriggerHovered = shallowRef(false)
  const anchorRect = shallowRef<DOMRect | null>(null)
  const editorDom = shallowRef<HTMLElement | null>(getEditorDomSafely(editor))

  const shouldRenderTriggerMenu = computed(() =>
    canShowTriggerMenu()
    && Boolean(anchorRect.value)
    && isAnchorRectVisible(anchorRect.value),
  )
  const shouldKeepLinkPanelMounted = computed(() =>
    visible.value && activePanel.value === 'link' && shouldRenderTriggerMenu.value,
  )
  const isTriggerButtonVisible = computed(() =>
    shouldRenderTriggerMenu.value
    && (
      visible.value
      || isTriggerHotspotHovered.value
      || isTriggerHovered.value
      || (isEditorFocused.value && isCurrentEmptyParagraphBlock())
    ),
  )

  const anchorStyle = computed(() => {
    if (!anchorRect.value) {
      return undefined
    }

    const buttonWidth = isCurrentEmptyParagraphBlock()
      ? BLOCK_TRIGGER_EMPTY_BUTTON_WIDTH
      : BLOCK_TRIGGER_BUTTON_WIDTH

    return {
      left: `${anchorRect.value.left - buttonWidth - BLOCK_TRIGGER_BUTTON_GAP}px`,
      top: `${anchorRect.value.top + anchorRect.value.height / 2 - BLOCK_TRIGGER_BUTTON_HEIGHT / 2}px`,
    }
  })

  if (canShowTriggerMenu()) {
    syncAnchorRect()
  }

  watch(visible, (nextVisible) => {
    if (!nextVisible) {
      activePanel.value = 'root'
    }
  })

  onMounted(() => {
    if (canShowTriggerMenu()) {
      syncAnchorRect()
    }

    editorDom.value = getEditorDomSafely(editor)
    editor.on('selectionUpdate', handleSelectionUpdate)
    editor.on('focus', handleEditorFocus)
    editor.on('blur', handleEditorBlur)
    editorDom.value?.addEventListener('mouseenter', handleEditorMouseEnter)
    editorDom.value?.addEventListener('mousemove', handleEditorMouseMove)
    editorDom.value?.addEventListener('mouseleave', handleEditorMouseLeave)
    window.addEventListener('resize', handleViewportChange)
    document.addEventListener('scroll', handleViewportChange, true)
  })

  onBeforeUnmount(() => {
    closeMenu()
    anchorRect.value = null
    isTriggerHovered.value = false
    editor.off('selectionUpdate', handleSelectionUpdate)
    editor.off('focus', handleEditorFocus)
    editor.off('blur', handleEditorBlur)
    editorDom.value?.removeEventListener('mouseenter', handleEditorMouseEnter)
    editorDom.value?.removeEventListener('mousemove', handleEditorMouseMove)
    editorDom.value?.removeEventListener('mouseleave', handleEditorMouseLeave)
    window.removeEventListener('resize', handleViewportChange)
    document.removeEventListener('scroll', handleViewportChange, true)
    editorDom.value = null
  })

  return {
    visible,
    activePanel,
    shouldRenderTriggerMenu,
    shouldKeepLinkPanelMounted,
    isTriggerButtonVisible,
    anchorStyle,
    canShowTriggerMenu,
    openMenu,
    openPanel,
    closeMenu,
    handleTriggerMouseEnter,
    handleTriggerMouseLeave,
  } satisfies BlockTriggerOverlayController

  function canShowTriggerMenu() {
    return hasEditorView()
      && editor.isEditable
      && Boolean(getCurrentBlock(editor.state.selection))
  }

  function isCurrentEmptyParagraphBlock() {
    const currentBlock = getCurrentBlock(editor.state.selection)
    const textContent = currentBlock?.node.textContent ?? editor.state.selection.$from.parent.textContent ?? ''

    return currentBlock?.node.type.name === 'paragraph' && textContent.trim().length === 0
  }

  function openMenu() {
    if (!canShowTriggerMenu()) {
      return false
    }

    syncAnchorRect()

    if (!anchorRect.value || !isAnchorRectVisible(anchorRect.value)) {
      return false
    }

    visible.value = true
    activePanel.value = 'root'
    return true
  }

  function openPanel(panel: Exclude<BlockTriggerPanel, 'root'>) {
    if (!canShowTriggerMenu()) {
      return false
    }

    if (visible.value && activePanel.value === panel) {
      showRootPanel()
      return false
    }

    syncAnchorRect()
    visible.value = true
    activePanel.value = panel
    return true
  }

  function showRootPanel() {
    if (!visible.value) {
      return
    }

    activePanel.value = 'root'
  }

  function closeMenu() {
    visible.value = false
    activePanel.value = 'root'
  }

  function handleTriggerMouseEnter() {
    isTriggerHovered.value = true
  }

  function handleTriggerMouseLeave() {
    isTriggerHovered.value = false
  }

  function syncAnchorRect() {
    if (!hasEditorView()) {
      anchorRect.value = null
      return
    }

    anchorRect.value = resolveBlockTriggerAnchorRect(editor)
  }

  function handleSelectionUpdate(_event?: EditorEvents['selectionUpdate']) {
    if (!canShowTriggerMenu()) {
      anchorRect.value = null
      isTriggerHotspotHovered.value = false
      closeMenu()
      return
    }

    syncAnchorRect()
    isTriggerHotspotHovered.value = false
  }

  function handleEditorFocus() {
    isEditorFocused.value = true

    if (canShowTriggerMenu()) {
      syncAnchorRect()
    }
  }

  function handleEditorBlur() {
    isEditorFocused.value = false
    handleSelectionUpdate()
  }

  function handleEditorMouseEnter(event: MouseEvent) {
    if (canShowTriggerMenu()) {
      syncAnchorRect()
    }

    syncTriggerHotspotHover(event)
  }

  function handleEditorMouseMove(event: MouseEvent) {
    if (!canShowTriggerMenu()) {
      isTriggerHotspotHovered.value = false
      return
    }

    syncTriggerHotspotHover(event)
  }

  function handleEditorMouseLeave() {
    isTriggerHotspotHovered.value = false
  }

  function handleViewportChange() {
    if (!canShowTriggerMenu()) {
      return
    }

    syncAnchorRect()
  }

  function hasEditorView() {
    return Boolean(getEditorDomSafely(editor))
  }

  function syncTriggerHotspotHover(event: MouseEvent) {
    isTriggerHotspotHovered.value = isPointerInsideTriggerHotspot(event)
  }

  function isPointerInsideTriggerHotspot(event: MouseEvent) {
    if (!anchorRect.value) {
      return false
    }

    const buttonWidth = isCurrentEmptyParagraphBlock()
      ? BLOCK_TRIGGER_EMPTY_BUTTON_WIDTH
      : BLOCK_TRIGGER_BUTTON_WIDTH
    const left = anchorRect.value.left - buttonWidth - BLOCK_TRIGGER_BUTTON_GAP - BLOCK_TRIGGER_HOTSPOT_X_PADDING
    const right = anchorRect.value.left + BLOCK_TRIGGER_HOTSPOT_X_PADDING
    const top = anchorRect.value.top - BLOCK_TRIGGER_HOTSPOT_Y_PADDING
    const bottom = anchorRect.value.bottom + BLOCK_TRIGGER_HOTSPOT_Y_PADDING

    return event.clientX >= left
      && event.clientX <= right
      && event.clientY >= top
      && event.clientY <= bottom
  }

  function isAnchorRectVisible(rect: DOMRect | null) {
    if (!rect) {
      return false
    }

    const visibleRect = resolveEditorVisibleRect()

    return rect.bottom >= visibleRect.top
      && rect.top <= visibleRect.bottom
      && rect.right >= visibleRect.left
      && rect.left <= visibleRect.right
  }

  function resolveEditorVisibleRect() {
    const scrollContainer = findScrollContainer(editorDom.value ?? getEditorDomSafely(editor))

    if (scrollContainer) {
      return scrollContainer.getBoundingClientRect()
    }

    return {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    }
  }
}

function getEditorViewSafely(editor: Editor) {
  try {
    return editor.view
  }
  catch {
    return null
  }
}

function getEditorDomSafely(editor: Editor) {
  const view = getEditorViewSafely(editor)

  return view?.dom instanceof HTMLElement ? view.dom : null
}

function findScrollContainer(element: HTMLElement | null) {
  let current = element?.parentElement ?? null

  while (current) {
    const style = window.getComputedStyle(current)

    if (/auto|scroll|overlay/.test(style.overflowY)) {
      return current
    }

    current = current.parentElement
  }

  return null
}
