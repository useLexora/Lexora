import type { Ref } from 'vue'
import { computed, nextTick, onBeforeUnmount, shallowRef } from 'vue'

export function useWorkbenchSidebarToggle(options: {
  container: Readonly<Ref<HTMLElement | null>>
  sidebar: Readonly<Ref<HTMLElement | null>>
  collapsed: Ref<boolean>
}) {
  const sidebarTransitioning = shallowRef(false)
  const sidebarToggleTop = shallowRef<string | null>(null)
  const sidebarToggleStyle = computed(() => sidebarToggleTop.value ? { top: sidebarToggleTop.value } : undefined)
  let timer: number | null = null
  let frame: number | null = null
  let disposed = false

  async function toggleSidebar(): Promise<void> {
    if (sidebarTransitioning.value)
      return
    sidebarTransitioning.value = true
    await nextTick()
    if (disposed)
      return
    frame = requestAnimationFrame(() => {
      frame = null
      options.collapsed.value = !options.collapsed.value
      timer = window.setTimeout(finishSidebarTransition, 280)
    })
  }

  function finishSidebarTransition(event?: TransitionEvent): void {
    if (event && (event.target !== options.sidebar.value || event.propertyName !== 'width'))
      return
    if (timer !== null)
      window.clearTimeout(timer)
    timer = null
    sidebarTransitioning.value = false
  }

  function updateSidebarTogglePosition(event: PointerEvent): void {
    const bounds = options.container.value?.getBoundingClientRect()
    if (!bounds)
      return
    const halfToggleHeight = 16
    const maximum = Math.max(halfToggleHeight, bounds.height - halfToggleHeight)
    const offset = Math.min(maximum, Math.max(halfToggleHeight, event.clientY - bounds.top))
    sidebarToggleTop.value = `${offset}px`
  }

  onBeforeUnmount(() => {
    disposed = true
    if (frame !== null)
      cancelAnimationFrame(frame)
    if (timer !== null)
      window.clearTimeout(timer)
  })

  return { sidebarTransitioning, sidebarToggleStyle, toggleSidebar, finishSidebarTransition, updateSidebarTogglePosition }
}
