import type { ComponentPublicInstance, ShallowRef } from 'vue'
import type { LinkPanelController } from './useLinkPanel'
import { nextTick, shallowRef, watch } from 'vue'
import {
  resolvePanelInputKeydownAction,
  shouldFocusPanelPrimaryInput,
} from './panelInputPolicy'

interface FocusableElement {
  focus: () => void
}

type LinkPanelRefTarget = Element | ComponentPublicInstance | null

export interface LinkPanelViewController {
  primaryInputRef: ShallowRef<FocusableElement | null>
  secondaryInputRef: ShallowRef<FocusableElement | null>
  assignPrimaryInputRef: (element: LinkPanelRefTarget) => void
  assignSecondaryInputRef: (element: LinkPanelRefTarget) => void
  keepPrimaryInputFocus: () => void
  keepSecondaryInputFocus: () => void
  handleInputKeydown: (event: Event | KeyboardEvent) => void
}

export function useLinkPanelView(controller: LinkPanelController): LinkPanelViewController {
  const primaryInputRef = shallowRef<FocusableElement | null>(null)
  const secondaryInputRef = shallowRef<FocusableElement | null>(null)

  watch(
    () => [controller.isOpen.value, controller.mode.value] as const,
    async ([isOpen]) => {
      if (!shouldFocusPanelPrimaryInput({
        isOpen,
        shouldFocusInputOnOpen: controller.shouldFocusInputOnOpen.value,
      })) {
        return
      }

      await nextTick()
      keepPrimaryInputFocus()
    },
  )

  function assignPrimaryInputRef(element: LinkPanelRefTarget) {
    primaryInputRef.value = normalizeFocusableElement(element)
  }

  function assignSecondaryInputRef(element: LinkPanelRefTarget) {
    secondaryInputRef.value = normalizeFocusableElement(element)
  }

  function keepPrimaryInputFocus() {
    keepInputFocus(primaryInputRef)
  }

  function keepSecondaryInputFocus() {
    keepInputFocus(secondaryInputRef)
  }

  function handleInputKeydown(event: Event | KeyboardEvent) {
    if (!(event instanceof KeyboardEvent)) {
      return
    }

    const action = resolvePanelInputKeydownAction({
      hasSecondaryInput: controller.mode.value !== 'selection',
      isComposing: event.isComposing,
      key: event.key,
      shiftKey: event.shiftKey,
    })

    if (action === 'ignore') {
      return
    }

    event.preventDefault()

    if (action === 'apply') {
      controller.apply()
      return
    }

    if (action === 'cancel') {
      controller.cancel()
      return
    }

    secondaryInputRef.value?.focus()
  }

  return {
    primaryInputRef,
    secondaryInputRef,
    assignPrimaryInputRef,
    assignSecondaryInputRef,
    keepPrimaryInputFocus,
    keepSecondaryInputFocus,
    handleInputKeydown,
  }
}

function normalizeFocusableElement(target: LinkPanelRefTarget): FocusableElement | null {
  if (!target || typeof target !== 'object') {
    return null
  }

  const focus = (target as unknown as { focus?: unknown }).focus
  return typeof focus === 'function' ? target as unknown as FocusableElement : null
}

function keepInputFocus(target: ShallowRef<FocusableElement | null>) {
  if (typeof window === 'undefined') {
    target.value?.focus()
    return
  }

  window.requestAnimationFrame(() => target.value?.focus())
}
