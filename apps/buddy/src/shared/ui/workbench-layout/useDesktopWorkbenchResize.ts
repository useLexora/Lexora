import type { Ref } from 'vue'
import type { DesktopWorkbenchResizablePanel } from './desktopWorkbenchLayout'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  readonly,
  shallowRef,
  watch,
} from 'vue'
import {
  clampDesktopWorkbenchPanelWidth,
  DESKTOP_WORKBENCH_WIDTH_LIMITS,
  resolveDesktopWorkbenchPanelRange,
  resolveDesktopWorkbenchWidths,
} from './desktopWorkbenchLayout'

interface UseDesktopWorkbenchResizeOptions {
  workspaceMinimumWidth?: () => number
  container: Readonly<Ref<HTMLElement | null>>
  context: Readonly<Ref<HTMLElement | null>>
  contextVisible?: () => boolean
  sidebar: Readonly<Ref<HTMLElement | null>>
  sidebarResizable: () => boolean
  sidebarVisible: () => boolean
  sidebarPreferredWidth?: () => number | null
  onSidebarWidthCommit?: (width: number) => void
}

const KEYBOARD_RESIZE_STEP = 16
const KEYBOARD_RESIZE_LARGE_STEP = 48

export function useDesktopWorkbenchResize(options: UseDesktopWorkbenchResizeOptions) {
  const activePanel = shallowRef<DesktopWorkbenchResizablePanel | null>(null)
  const containerWidth = shallowRef(0)
  const preferredContextWidth = shallowRef<number | null>(null)
  const preferredSidebarWidth = shallowRef<number | null>(null)
  const renderedSidebarWidth = shallowRef<number | null>(null)
  let resizeObserver: ResizeObserver | null = null
  let activePointerId: number | null = null
  let activePointerTarget: HTMLElement | null = null
  let resizeBounds: Pick<DOMRect, 'left' | 'right'> | null = null
  let pendingClientX: number | null = null
  let resizeFrame: number | null = null
  let sidebarWidthTouched = false

  const contextVisible = computed(() => options.context.value !== null && (options.contextVisible?.() ?? true))
  const widths = computed(() => resolveDesktopWorkbenchWidths({
    workspaceMinimumWidth: options.workspaceMinimumWidth?.(),
    containerWidth: containerWidth.value,
    contextVisible: contextVisible.value,
    preferredContextWidth: preferredContextWidth.value
      ?? DESKTOP_WORKBENCH_WIDTH_LIMITS.context.minimum,
    preferredSidebarWidth: preferredSidebarWidth.value
      ?? DESKTOP_WORKBENCH_WIDTH_LIMITS.sidebar.minimum,
    sidebarVisible: options.sidebarVisible(),
  }))
  const sidebarRange = computed(() => resolvePanelRange('sidebar'))
  const contextRange = computed(() => resolvePanelRange('context'))
  const layoutStyle = computed<Record<string, string>>(() => {
    const style: Record<string, string> = {}
    if (preferredSidebarWidth.value !== null && options.sidebarResizable())
      style['--buddy-workspace-sidebar-width'] = `${renderedSidebarWidth.value ?? widths.value.sidebarWidth}px`
    return style
  })
  const contextStyle = computed(() => preferredContextWidth.value !== null && contextVisible.value
    ? { width: `${widths.value.contextWidth}px` }
    : undefined)

  function measureLayout(): void {
    const container = options.container.value
    if (!container)
      return

    const bounds = container.getBoundingClientRect()
    containerWidth.value = bounds.width
    if (activePanel.value)
      resizeBounds = bounds
    if (preferredSidebarWidth.value === null && options.sidebar.value)
      preferredSidebarWidth.value = options.sidebar.value.getBoundingClientRect().width
    if (preferredContextWidth.value === null && contextVisible.value && options.context.value)
      preferredContextWidth.value = options.context.value.getBoundingClientRect().width
  }

  function resolvePanelRange(panel: DesktopWorkbenchResizablePanel) {
    return resolveDesktopWorkbenchPanelRange(panel, {
      workspaceMinimumWidth: options.workspaceMinimumWidth?.(),
      containerWidth: containerWidth.value,
      contextVisible: contextVisible.value,
      contextWidth: widths.value.contextWidth,
      sidebarWidth: widths.value.sidebarWidth,
      sidebarVisible: options.sidebarVisible(),
    })
  }

  function setPanelWidth(panel: DesktopWorkbenchResizablePanel, width: number): void {
    const nextWidth = clampDesktopWorkbenchPanelWidth(width, resolvePanelRange(panel))
    if (panel === 'sidebar') {
      preferredSidebarWidth.value = nextWidth
      sidebarWidthTouched = true
    }
    else {
      preferredContextWidth.value = nextWidth
    }
  }

  function resizeFromClientX(panel: DesktopWorkbenchResizablePanel, clientX: number): void {
    const bounds = resizeBounds
    if (!bounds)
      return
    setPanelWidth(
      panel,
      panel === 'sidebar' ? clientX - bounds.left : bounds.right - clientX,
    )
  }

  function flushResize(): void {
    resizeFrame = null
    if (activePanel.value && pendingClientX !== null)
      resizeFromClientX(activePanel.value, pendingClientX)
    pendingClientX = null
  }

  function beginResize(panel: DesktopWorkbenchResizablePanel, event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary)
      return
    measureLayout()
    preferredSidebarWidth.value = options.sidebar.value?.getBoundingClientRect().width
      ?? preferredSidebarWidth.value
    if (contextVisible.value && options.context.value)
      preferredContextWidth.value = options.context.value.getBoundingClientRect().width
    activePanel.value = panel
    resizeBounds = options.container.value?.getBoundingClientRect() ?? null
    activePointerId = event.pointerId
    activePointerTarget = event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : null
    activePointerTarget?.setPointerCapture(event.pointerId)
    resizeFromClientX(panel, event.clientX)
    window.addEventListener('blur', finishResize)
    window.addEventListener('pointercancel', handlePointerEnd)
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerEnd)
    event.preventDefault()
  }

  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerId !== activePointerId || !activePanel.value)
      return
    pendingClientX = event.clientX
    if (resizeFrame === null)
      resizeFrame = requestAnimationFrame(flushResize)
    event.preventDefault()
  }

  function handlePointerEnd(event: PointerEvent): void {
    if (event.pointerId === activePointerId) {
      if (event.type === 'pointerup')
        pendingClientX = event.clientX
      finishResize()
    }
  }

  function finishResize(): void {
    if (resizeFrame !== null)
      cancelAnimationFrame(resizeFrame)
    flushResize()
    if (
      activePointerId !== null
      && activePointerTarget?.hasPointerCapture(activePointerId)
    ) {
      activePointerTarget.releasePointerCapture(activePointerId)
    }
    if (activePanel.value === 'sidebar' && sidebarWidthTouched && preferredSidebarWidth.value !== null)
      options.onSidebarWidthCommit?.(preferredSidebarWidth.value)
    activePanel.value = null
    activePointerId = null
    activePointerTarget = null
    resizeBounds = null
    window.removeEventListener('blur', finishResize)
    window.removeEventListener('pointercancel', handlePointerEnd)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerEnd)
  }

  function handleResizeKeydown(
    panel: DesktopWorkbenchResizablePanel,
    event: KeyboardEvent,
  ): void {
    const range = resolvePanelRange(panel)
    const currentWidth = panel === 'sidebar'
      ? widths.value.sidebarWidth
      : widths.value.contextWidth
    const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP
    let nextWidth: number | null = null

    if (event.key === 'Home')
      nextWidth = range.minimum
    else if (event.key === 'End')
      nextWidth = range.maximum
    else if (event.key === 'ArrowLeft')
      nextWidth = currentWidth + (panel === 'context' ? step : -step)
    else if (event.key === 'ArrowRight')
      nextWidth = currentWidth + (panel === 'context' ? -step : step)

    if (nextWidth === null)
      return
    setPanelWidth(panel, nextWidth)
    if (panel === 'sidebar' && preferredSidebarWidth.value !== null)
      options.onSidebarWidthCommit?.(preferredSidebarWidth.value)
    event.preventDefault()
  }

  onMounted(() => {
    const preferred = options.sidebarPreferredWidth?.() ?? null
    if (preferred !== null)
      preferredSidebarWidth.value = preferred
    measureLayout()
    resizeObserver = new ResizeObserver(measureLayout)
    if (options.container.value)
      resizeObserver.observe(options.container.value)
  })

  watch(
    () => options.sidebarPreferredWidth?.() ?? null,
    (width) => {
      if (width === null || sidebarWidthTouched || activePanel.value !== null)
        return
      preferredSidebarWidth.value = width
    },
  )

  watch(contextVisible, async (visible) => {
    if (!visible) {
      if (activePanel.value === 'context')
        finishResize()
      return
    }
    await nextTick()
    measureLayout()
  }, { flush: 'post' })

  watch(widths, (nextWidths) => {
    if (options.sidebarVisible())
      renderedSidebarWidth.value = nextWidths.sidebarWidth
  }, { immediate: true })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    finishResize()
  })

  return {
    activePanel: readonly(activePanel),
    contextRange,
    contextStyle,
    contextWidth: computed(() => widths.value.contextWidth),
    layoutStyle,
    sidebarRange,
    sidebarWidth: computed(() => widths.value.sidebarWidth),
    beginResize,
    handleResizeKeydown,
  }
}
