import type { EventSnapshot } from '../events/eventTypes'
import type { ReadonlyJsonValue } from '../workbench/workbenchState'
import type { AnchorGeometry, MountGeometry } from '../workbench/workbenchUi'

export interface ViewEnvironment {
  readonly language: string
  readonly colorScheme: 'light' | 'dark'
  readonly colors: Readonly<Record<string, string>>
}
export interface ViewStateEvents {
  'view:visibility:changed': { readonly visible: boolean }
  'view:environment:changed': { readonly environment: ViewEnvironment }
}
export interface ViewGeometryEvents {
  'view:mount:changed': { readonly mount: EventSnapshot<MountGeometry> }
  'view:anchor:changed': { readonly anchor: EventSnapshot<AnchorGeometry> }
}
export interface ViewMessageEvents {
  'view:message:received': { readonly message: ReadonlyJsonValue }
}
