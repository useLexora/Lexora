import type { ComponentPublicInstance } from 'vue'
import type { MathPanelController } from './useMathPanel'
import { nextTick, shallowRef, watch } from 'vue'

interface FocusableElement {
  focus: () => void
}

type MathPanelRefTarget = ComponentPublicInstance | Element | null

export function useMathPanelView(controller: MathPanelController) {
  const inputRef = shallowRef<FocusableElement | null>(null)

  watch(
    () => [controller.isOpen.value, controller.mode.value] as const,
    async ([isOpen]) => {
      if (!isOpen) {
        return
      }

      await nextTick()
      inputRef.value?.focus()
    },
  )

  function assignInputRef(element: MathPanelRefTarget) {
    inputRef.value = normalizeFocusableElement(element)
  }

  function handleInputKeydown(event: Event | KeyboardEvent) {
    if (!(event instanceof KeyboardEvent)) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      controller.cancel()
      return
    }

    if (controller.mode.value === 'inline' && event.key === 'Enter') {
      event.preventDefault()
      controller.apply()
      return
    }

    if (
      controller.mode.value === 'block'
      && event.key === 'Enter'
      && (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault()
      controller.apply()
    }
  }

  return {
    assignInputRef,
    handleInputKeydown,
  }
}

function normalizeFocusableElement(target: MathPanelRefTarget): FocusableElement | null {
  if (!target || typeof target !== 'object') {
    return null
  }

  const focus = (target as unknown as { focus?: unknown }).focus
  return typeof focus === 'function' ? target as unknown as FocusableElement : null
}
