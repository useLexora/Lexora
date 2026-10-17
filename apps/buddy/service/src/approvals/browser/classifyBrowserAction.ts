import type { BrowserAction, BrowserObservedElement } from '../../../../shared/browser'

export type BrowserActionClassification
  = { access: 'read' | 'interaction' }
    | { blocked: true, reason: 'BROWSER_HUMAN_INPUT_REQUIRED' }

export interface ClassifyBrowserActionInput {
  action: BrowserAction
  observationContainsHumanInput: boolean
  target: BrowserObservedElement | null
}

export function classifyBrowserAction(
  input: ClassifyBrowserActionInput,
): BrowserActionClassification {
  const { action, target } = input
  if (
    (target?.inputMode === 'human' && action.kind !== 'scroll' && action.kind !== 'wait')
    || (action.kind === 'press' && !action.ref && input.observationContainsHumanInput)
  ) {
    return { blocked: true, reason: 'BROWSER_HUMAN_INPUT_REQUIRED' }
  }

  switch (action.kind) {
    case 'scroll':
    case 'stop':
    case 'wait':
      return { access: 'read' }
    case 'back':
    case 'forward':
    case 'reload':
    case 'navigate':
    case 'fill':
    case 'select':
    case 'type':
    case 'click':
    case 'press':
      return { access: 'interaction' }
  }
}
