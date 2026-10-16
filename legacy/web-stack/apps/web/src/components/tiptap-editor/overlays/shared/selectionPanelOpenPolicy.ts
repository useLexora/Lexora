export type SelectionPanelOpenSource
  = | 'keyboard-caret-navigation'
    | 'preview-edit'
    | 'toolbar'

export interface SelectionPanelOpenIntent {
  source?: SelectionPanelOpenSource
}

export interface SelectionPanelOpenPolicy {
  focusInput: boolean
  selectRange: boolean
}

export function resolveSelectionPanelOpenPolicy(
  intent: SelectionPanelOpenIntent = {},
): SelectionPanelOpenPolicy {
  if (intent.source === 'keyboard-caret-navigation') {
    return {
      focusInput: false,
      selectRange: false,
    }
  }

  return {
    focusInput: true,
    selectRange: true,
  }
}
