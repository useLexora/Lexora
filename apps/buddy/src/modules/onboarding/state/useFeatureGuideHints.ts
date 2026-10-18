import type { Hints, PopoverDOM } from 'driver.js/hints'
import type { FeatureDiscovery } from './useFeatureDiscovery'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { hints } from 'driver.js/hints'
import { watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import 'driver.js/dist/hints.css'
import '@/theme/feature-hints.scss'

export function useFeatureGuideHints(controller: FeatureDiscovery, language: () => BuddyLocale) {
  const { t } = useBuddyI18n(language)
  watch([controller.active, language], ([target], _, onCleanup) => {
    if (!target)
      return
    const step = target
    const progress = controller.progress.value!
    let guide: Hints | undefined
    let resize: ResizeObserver | undefined
    let openingFrame = 0
    let stopButtons: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(attach)

    function renderControls(popover: PopoverDOM) {
      popover.wrapper.setAttribute('data-feature', step.featureId)
      popover.wrapper.setAttribute('data-step', step.id)
      const buttons = [popover.nextButton]
      if (progress.total > 1) {
        popover.progress.textContent = `${progress.current} / ${progress.total}`
        popover.progress.setAttribute('aria-label', t('discovery.stepProgress', progress))
        popover.progress.style.display = 'flex'
        const exit = document.createElement('button')
        exit.type = 'button'
        exit.className = 'driver-popover-footer-btn buddy-feature-exit'
        exit.textContent = t('discovery.end')
        exit.addEventListener('click', controller.finish)
        popover.progress.append(exit)
        if (progress.current > 1) {
          const previous = document.createElement('button')
          previous.type = 'button'
          previous.className = 'driver-popover-footer-btn'
          previous.textContent = t('discovery.previous')
          previous.addEventListener('click', () => void controller.previous())
          popover.footerButtons.prepend(previous)
          buttons.push(previous)
        }
      }
      stopButtons?.()
      stopButtons = watch(controller.busy, (busy) => {
        for (const button of buttons)
          button.disabled = busy
      }, { immediate: true })
    }

    function attach() {
      const element = document.querySelector<HTMLElement>(step.selector)
      if (!element || !element.getClientRects().length)
        return false
      observer.disconnect()
      clearTimeout(timeout)
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
      guide = hints({
        hints: [{
          id: step.id,
          element: step.selector,
          beacon: { side: step.side, align: step.align, animate: false, className: 'buddy-feature-hint' },
          popover: {
            title: t(step.title),
            description: t(step.description),
            side: step.side,
            align: step.align,
            onPopoverRender: renderControls,
          },
        }],
        overlay: false,
        popoverClass: 'buddy-feature-popover',
        buttonText: t(progress.total === 1 ? 'discovery.understood' : progress.current === progress.total ? 'discovery.complete' : 'discovery.next'),
        onButtonClick: () => void controller.next(),
        onOpen: () => controller.arrived(step.id),
        onDismiss: controller.finish,
      })
      guide.show()
      openingFrame = requestAnimationFrame(() => guide?.open(step.id))
      resize = new ResizeObserver(() => guide?.refresh())
      resize.observe(element)
      return true
    }

    if (!attach()) {
      observer.observe(document.querySelector('.desktop-shell') ?? document.body, { childList: true, subtree: true })
      timeout = setTimeout(() => controller.unavailable(), 5000)
    }
    onCleanup(() => {
      observer.disconnect()
      resize?.disconnect()
      stopButtons?.()
      clearTimeout(timeout)
      cancelAnimationFrame(openingFrame)
      guide?.hide()
    })
  }, { flush: 'post' })
}
