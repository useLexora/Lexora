import type { EventSnapshot } from '../events/eventTypes'
import type { WorkbenchContextSnapshot } from './workbenchContext'
import type { WorkbenchPaneSnapshot } from './workbenchInteraction'
import type { ComposerActivity, ControlSnapshot } from './workbenchUi'

export interface WorkbenchPaneEvents {
  'workbench:panes:changed': { readonly panes: EventSnapshot<WorkbenchPaneSnapshot[]> }
}
export interface WorkbenchContextEvents {
  'workbench:context:changed': { readonly context: WorkbenchContextSnapshot }
}
export interface ControlEvents {
  'control:changed': { readonly control: EventSnapshot<ControlSnapshot> }
}
export interface InteractionEvents {
  'interaction:activated': { readonly regionId: string, readonly x: number, readonly y: number }
}
export interface ComposerEvents {
  'composer:input:received': { readonly caret?: EventSnapshot<ComposerActivity['caret']> }
}
