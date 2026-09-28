import type { EventMessage } from '../events/eventTypes'
import type { ComposerEvents, ControlEvents, InteractionEvents, WorkbenchContextEvents, WorkbenchPaneEvents } from '../workbench/workbenchEvents'
import type { ConfigurationEvents } from './extensionSettings'
import type { ViewGeometryEvents, ViewMessageEvents, ViewStateEvents } from './extensionViewEvents'
import type { ExtensionViewUpdate } from './extensionViewProjection'

export interface ExtensionHostEvents extends ConfigurationEvents, WorkbenchPaneEvents {}
export interface ExtensionViewEvents extends ViewStateEvents, ViewGeometryEvents, ViewMessageEvents, WorkbenchContextEvents, ControlEvents, InteractionEvents, ComposerEvents {}
export type ExtensionViewNotification = EventMessage<ExtensionViewEvents>
export type ExtensionViewHostMessage = ExtensionViewUpdate | { ping: string } | { id: string, ok: boolean, value: unknown }
