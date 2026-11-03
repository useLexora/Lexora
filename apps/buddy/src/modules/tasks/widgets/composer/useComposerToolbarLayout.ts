import type { Ref } from 'vue'
import { useEventListener, useMutationObserver, useResizeObserver } from '@vueuse/core'
import { onMounted, onScopeDispose } from 'vue'

const compactionSteps = ['space-short', 'effort', 'space', 'model-short', 'permission', 'model', 'tight'] as const

export function useComposerToolbarLayout(
  toolbar: Readonly<Ref<HTMLElement | null>>,
  leading: Readonly<Ref<HTMLElement | null>>,
  actions: Readonly<Ref<HTMLElement | null>>,
) {
  const measurements = new Map<number, { leading: number, actions: number, gap: number }>()
  let level = 0
  let frame = 0
  let available: number | null = null

  function apply(element: HTMLElement, candidate: number) {
    const compact = compactionSteps.slice(0, candidate).join(' ')
    if (element.dataset.compact !== compact)
      element.dataset.compact = compact
  }

  function measure() {
    frame = 0
    const element = toolbar.value
    const left = leading.value
    const right = actions.value
    if (!element || !left || !right)
      return

    const width = available ?? element.getBoundingClientRect().width
    if (!width)
      return

    for (let candidate = 0; candidate <= compactionSteps.length; candidate++) {
      let measured = measurements.get(candidate)
      if (!measured) {
        apply(element, candidate)
        measured = {
          gap: Number.parseFloat(getComputedStyle(element).columnGap) || 0,
          leading: left.getBoundingClientRect().width,
          actions: right.getBoundingClientRect().width,
        }
        measurements.set(candidate, measured)
      }
      const required = measured.leading + measured.actions + measured.gap
      const recoveryMargin = candidate < level ? 12 : 0
      if (required + recoveryMargin <= width || candidate === compactionSteps.length) {
        level = candidate
        apply(element, candidate)
        break
      }
    }
  }

  function schedule() {
    if (!frame)
      frame = requestAnimationFrame(measure)
  }

  function invalidate() {
    measurements.clear()
    schedule()
  }

  onMounted(measure)
  useResizeObserver([toolbar, leading, actions], (entries) => {
    let changed = false
    for (const entry of entries) {
      const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width
      if (entry.target === toolbar.value) {
        if (available !== width) {
          available = width
          changed = true
        }
      }
      else {
        const measured = measurements.get(level)
        const previous = entry.target === leading.value ? measured?.leading : measured?.actions
        if (previous !== undefined && Math.abs(width - previous) > 0.5) {
          measurements.clear()
          changed = true
        }
      }
    }
    if (changed)
      schedule()
  })
  useMutationObserver(toolbar, invalidate, { childList: true, characterData: true, subtree: true })
  useMutationObserver(document.documentElement, invalidate, { attributes: true, attributeFilter: ['style'] })
  useEventListener(document.fonts, 'loadingdone', invalidate)
  onScopeDispose(() => cancelAnimationFrame(frame))
}
