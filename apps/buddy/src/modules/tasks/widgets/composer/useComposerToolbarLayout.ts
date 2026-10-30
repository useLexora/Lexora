import type { Ref } from 'vue'
import { useEventListener, useMutationObserver, useResizeObserver } from '@vueuse/core'
import { onMounted, onScopeDispose } from 'vue'

const compactionSteps = ['space-short', 'effort', 'space', 'model-short', 'permission', 'model', 'tight'] as const

export function useComposerToolbarLayout(
  toolbar: Readonly<Ref<HTMLElement | null>>,
  leading: Readonly<Ref<HTMLElement | null>>,
  actions: Readonly<Ref<HTMLElement | null>>,
) {
  let level = 0
  let frame = 0

  function measure() {
    frame = 0
    const element = toolbar.value
    const left = leading.value
    const right = actions.value
    if (!element || !left || !right)
      return

    const available = element.getBoundingClientRect().width
    if (!available)
      return

    for (let candidate = 0; candidate <= compactionSteps.length; candidate++) {
      element.dataset.compact = compactionSteps.slice(0, candidate).join(' ')
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0
      const required = left.getBoundingClientRect().width + right.getBoundingClientRect().width + gap
      const recoveryMargin = candidate < level ? 12 : 0
      if (required + recoveryMargin <= available || candidate === compactionSteps.length) {
        level = candidate
        break
      }
    }
  }

  function schedule() {
    if (!frame)
      frame = requestAnimationFrame(measure)
  }

  onMounted(measure)
  useResizeObserver([toolbar, leading, actions], schedule)
  useMutationObserver(toolbar, schedule, { childList: true, characterData: true, subtree: true })
  useMutationObserver(document.documentElement, schedule, { attributes: true, attributeFilter: ['style'] })
  useEventListener(document.fonts, 'loadingdone', schedule)
  onScopeDispose(() => cancelAnimationFrame(frame))
}
