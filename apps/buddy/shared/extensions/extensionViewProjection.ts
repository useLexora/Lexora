import type { EventSnapshot } from '../events/eventTypes'
import type { WorkbenchContextSnapshot } from '../workbench/workbenchContext'
import type { AnchorGeometry, ControlSnapshot, MountGeometry } from '../workbench/workbenchUi'
import type { ExtensionViewNotification } from './extensionEvents'
import type { ViewEnvironment } from './extensionViewEvents'
import { copyEventSnapshot } from '../events/eventSnapshot'

export interface ExtensionViewSnapshot {
  readonly workbench: WorkbenchContextSnapshot
  readonly environment: ViewEnvironment
  readonly visible: boolean
  readonly mount: EventSnapshot<MountGeometry> | null
  readonly anchor: EventSnapshot<AnchorGeometry> | null
  readonly control: EventSnapshot<ControlSnapshot> | null
}
export interface ExtensionViewPolicy {
  readonly decoration: boolean
  readonly control: boolean
  readonly interaction: boolean
}
export interface ExtensionViewCursor {
  readonly streamId: string
  readonly sequence: number
}
export interface ExtensionViewUpdate extends ExtensionViewCursor {
  readonly event: ExtensionViewNotification
}
export interface ExtensionViewSynchronization extends ExtensionViewCursor {
  readonly snapshot: ExtensionViewSnapshot
}

export function projectExtensionViewEvent(snapshot: ExtensionViewSnapshot, input: ExtensionViewNotification, policy: ExtensionViewPolicy): { snapshot: ExtensionViewSnapshot, event: ExtensionViewNotification } | null {
  const event = copyEventSnapshot<unknown>(input) as ExtensionViewNotification
  let update: Partial<ExtensionViewSnapshot> = {}
  switch (event.type) {
    case 'workbench:context:changed':
      update = { workbench: event.data.context }
      break
    case 'view:environment:changed':
      update = { environment: event.data.environment }
      break
    case 'view:visibility:changed':
      update = { visible: event.data.visible }
      break
    case 'view:mount:changed':
      update = { mount: event.data.mount }
      break
    case 'view:anchor:changed':
      if (!policy.decoration)
        return null
      update = { anchor: event.data.anchor }
      break
    case 'control:changed':
      if (!policy.control)
        return null
      update = { control: event.data.control }
      break
    case 'composer:input:received':
      if (!policy.decoration)
        return null
      break
    case 'interaction:activated':
      if (!policy.interaction)
        return null
      break
    case 'view:message:received': break
    default: return null
  }
  if (Object.keys(update).length && Object.entries(update).every(([key, value]) => JSON.stringify(snapshot[key as keyof ExtensionViewSnapshot]) === JSON.stringify(value)))
    return null
  return { snapshot: Object.freeze({ ...snapshot, ...update }), event }
}

export function ownExtensionViewSnapshot(snapshot: ExtensionViewSnapshot, policy: ExtensionViewPolicy): ExtensionViewSnapshot {
  return copyEventSnapshot({ ...snapshot, anchor: policy.decoration ? snapshot.anchor : null, control: policy.control ? snapshot.control : null })
}
