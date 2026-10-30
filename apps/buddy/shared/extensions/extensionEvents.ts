import type { EventMessage } from '../events/eventTypes'
import type { ComposerEvents, ControlEvents, InteractionEvents, WorkbenchContextEvents, WorkbenchPaneEvents } from '../workbench/workbenchEvents'
import type { ExtensionReferenceReveal } from './extensionReferences'
import type { ConfigurationEvents } from './extensionSettings'
import type { ExtensionDataEvents, ViewGeometryEvents, ViewMessageEvents, ViewStateEvents } from './extensionViewEvents'
import type { ExtensionViewUpdate } from './extensionViewProjection'

export interface ExtensionHostEvents extends ConfigurationEvents, WorkbenchPaneEvents {}
export interface ExtensionViewEvents extends ExtensionDataEvents, ViewStateEvents, ViewGeometryEvents, ViewMessageEvents, WorkbenchContextEvents, ControlEvents, InteractionEvents, ComposerEvents {}
export type ExtensionViewNotification = EventMessage<ExtensionViewEvents>
export type ExtensionViewHostMessage = ExtensionViewUpdate | { referenceRequest: { id: string, input: ExtensionReferenceReveal } } | { referenceCancel: string } | { closeRequest: { id: string } } | { closeCancel: string } | { ping: string } | { id: string, ok: boolean, value: unknown }
