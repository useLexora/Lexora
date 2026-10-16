import type { Ref } from 'vue'
import { useElementSize, useEventListener } from '@vueuse/core'
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useUiStore } from '@/stores/ui'

const DOCS_CHAT_PANEL_MIN_WIDTH_REM = 20
const DOCS_CHAT_PANEL_DEFAULT_WIDTH_REM = 24
const DOCS_CHAT_PANEL_MAX_WIDTH_REM = 36
const DOCS_CHAT_PANEL_LIBRARY_WIDTH_REM = 16
const DOCS_CHAT_PANEL_MIN_SURFACE_WIDTH_REM = 40
const DOCS_CHAT_PANEL_KEYBOARD_STEP_REM = 1
const DOCS_CHAT_PANEL_KEYBOARD_LARGE_STEP_REM = 4
const FALLBACK_ROOT_FONT_SIZE = 16

interface UseDocsChatPanelResizeOptions {
  containerRef: Readonly<Ref<HTMLElement | null>>
  isDocumentLibraryVisible: Readonly<Ref<boolean>>
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function resolveRootFontSize() {
  if (typeof window === 'undefined') {
    return FALLBACK_ROOT_FONT_SIZE
  }

  const fontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(fontSize) ? fontSize : FALLBACK_ROOT_FONT_SIZE
}

function remToPx(rem: number) {
  return rem * resolveRootFontSize()
}

export function useDocsChatPanelResize(options: UseDocsChatPanelResizeOptions) {
  const uiStore = useUiStore()
  const isResizing = shallowRef(false)
  const { width: containerWidth } = useElementSize(options.containerRef)

  let pointerId: number | null = null
  let startClientX = 0
  let startWidthPx = 0
  let pendingWidthPx = 0
  let frameId: number | null = null
  let previousBodyCursor = ''
  let previousBodyUserSelect = ''

  const minWidthPx = computed(() => remToPx(DOCS_CHAT_PANEL_MIN_WIDTH_REM))
  const maxWidthPx = computed(() => {
    const fixedMaxWidth = remToPx(DOCS_CHAT_PANEL_MAX_WIDTH_REM)
    const libraryWidth = options.isDocumentLibraryVisible.value
      ? remToPx(DOCS_CHAT_PANEL_LIBRARY_WIDTH_REM)
      : 0
    const minSurfaceWidth = remToPx(DOCS_CHAT_PANEL_MIN_SURFACE_WIDTH_REM)
    const availableWidth = containerWidth.value > 0
      ? containerWidth.value - libraryWidth - minSurfaceWidth
      : fixedMaxWidth

    return Math.max(minWidthPx.value, Math.min(fixedMaxWidth, availableWidth))
  })
  const defaultWidthPx = computed(() => clamp(
    remToPx(DOCS_CHAT_PANEL_DEFAULT_WIDTH_REM),
    minWidthPx.value,
    maxWidthPx.value,
  ))
  const committedWidthPx = computed(() => clamp(
    uiStore.docsChatPanelPreferredWidthPx ?? defaultWidthPx.value,
    minWidthPx.value,
    maxWidthPx.value,
  ))
  const panelWidthStyle = computed(() => ({
    '--panel-docs-chat-width': `${Math.round(committedWidthPx.value)}px`,
  }))

  function applyPanelWidth(widthPx: number) {
    options.containerRef.value?.style.setProperty('--panel-docs-chat-width', `${Math.round(widthPx)}px`)
  }

  function readPanelWidth() {
    const panel = options.containerRef.value?.querySelector<HTMLElement>('.docs-chat-panel')
    return panel?.getBoundingClientRect().width ?? committedWidthPx.value
  }

  function commitWidth(widthPx: number) {
    const nextWidth = clamp(widthPx, minWidthPx.value, maxWidthPx.value)
    applyPanelWidth(nextWidth)
    uiStore.setDocsChatPanelPreferredWidthPx(nextWidth)
  }

  function lockBodyInteraction() {
    if (typeof document === 'undefined') {
      return
    }

    previousBodyCursor = document.body.style.cursor
    previousBodyUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function unlockBodyInteraction() {
    if (typeof document === 'undefined') {
      return
    }

    document.body.style.cursor = previousBodyCursor
    document.body.style.userSelect = previousBodyUserSelect
  }

  function flushPendingWidth() {
    frameId = null
    applyPanelWidth(pendingWidthPx)
  }

  function schedulePanelWidth(widthPx: number) {
    pendingWidthPx = clamp(widthPx, minWidthPx.value, maxWidthPx.value)

    if (frameId !== null || typeof window === 'undefined') {
      return
    }

    frameId = window.requestAnimationFrame(flushPendingWidth)
  }

  function finishResize() {
    if (pointerId === null) {
      return
    }

    if (frameId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }

    commitWidth(pendingWidthPx)
    pointerId = null
    isResizing.value = false
    unlockBodyInteraction()
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0 || !options.containerRef.value) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    pointerId = event.pointerId
    startClientX = event.clientX
    startWidthPx = readPanelWidth()
    pendingWidthPx = startWidthPx
    isResizing.value = true
    lockBodyInteraction()
    applyPanelWidth(startWidthPx)
  }

  function handlePointerMove(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) {
      return
    }

    event.preventDefault()
    schedulePanelWidth(startWidthPx + startClientX - event.clientX)
  }

  function handlePointerEnd(event: PointerEvent) {
    if (pointerId !== null && event.pointerId === pointerId) {
      finishResize()
    }
  }

  function handleWindowBlur() {
    finishResize()
  }

  function resetWidth() {
    applyPanelWidth(defaultWidthPx.value)
    uiStore.setDocsChatPanelPreferredWidthPx(null)
  }

  function handleKeydown(event: KeyboardEvent) {
    const currentWidth = readPanelWidth()
    const step = remToPx(event.shiftKey ? DOCS_CHAT_PANEL_KEYBOARD_LARGE_STEP_REM : DOCS_CHAT_PANEL_KEYBOARD_STEP_REM)
    let nextWidth: number | null = null

    if (event.key === 'ArrowLeft') {
      nextWidth = currentWidth + step
    }
    else if (event.key === 'ArrowRight') {
      nextWidth = currentWidth - step
    }
    else if (event.key === 'Home') {
      nextWidth = minWidthPx.value
    }
    else if (event.key === 'End') {
      nextWidth = maxWidthPx.value
    }

    if (nextWidth === null) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    commitWidth(nextWidth)
  }

  watch(
    () => [committedWidthPx.value, options.containerRef.value] as const,
    ([widthPx]) => {
      if (!isResizing.value) {
        applyPanelWidth(widthPx)
      }
    },
    { immediate: true },
  )

  useEventListener('pointermove', handlePointerMove, { passive: false })
  useEventListener('pointerup', handlePointerEnd)
  useEventListener('pointercancel', handlePointerEnd)
  useEventListener('blur', handleWindowBlur)

  onBeforeUnmount(() => {
    finishResize()
  })

  return {
    isResizing,
    maxWidthPx,
    minWidthPx,
    panelWidthStyle,
    resetWidth,
    startResize,
    widthPx: committedWidthPx,
    handleKeydown,
  }
}
