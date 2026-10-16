export type PanelInputKeydownAction
  = | 'apply'
    | 'cancel'
    | 'focus-secondary'
    | 'ignore'

interface PanelFocusInput {
  isOpen: boolean
  shouldFocusInputOnOpen: boolean
}

interface PanelInputKeydownInput {
  hasSecondaryInput: boolean
  isComposing: boolean
  key: string
  shiftKey: boolean
}

export function shouldFocusPanelPrimaryInput(input: PanelFocusInput) {
  return input.isOpen && input.shouldFocusInputOnOpen
}

export function resolvePanelInputKeydownAction(
  input: PanelInputKeydownInput,
): PanelInputKeydownAction {
  if (input.isComposing) {
    return 'ignore'
  }

  if (input.key === 'Enter') {
    return 'apply'
  }

  if (input.key === 'Escape') {
    return 'cancel'
  }

  if (input.hasSecondaryInput && input.key === 'Tab' && !input.shiftKey) {
    return 'focus-secondary'
  }

  return 'ignore'
}
