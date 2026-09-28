import type { Event } from '../events/Emitter'
import type { EventSnapshot } from '../events/eventTypes'
import { z } from 'zod'
import { lifecycleFailureSchema } from './lifecycleFailure'

export const SERVICE_LIFECYCLE_METHOD = 'runtime.lifecycle'
export const lifecycleIdentitySchema = z.string().regex(/^\w[\w:.-]{0,191}$/)
export const lifecycleComponentSchema = z.object({
  component: z.string().regex(/^[a-z][a-z\d._-]{0,95}$/),
  kind: z.enum(['service', 'operation']),
  status: z.enum(['registered', 'starting', 'ready', 'start_failed', 'stopping', 'stopped', 'stop_failed']),
  operationId: lifecycleIdentitySchema,
  durationMs: z.number().finite().nonnegative().optional(),
  failure: lifecycleFailureSchema.optional(),
}).strict().superRefine((component, context) => {
  if (component.kind === 'operation' && !['starting', 'ready', 'start_failed'].includes(component.status))
    context.addIssue({ code: 'custom', message: 'Invalid operation lifecycle status' })
})
export const serviceLifecycleSnapshotSchema = z.object({
  sourceId: lifecycleIdentitySchema,
  revision: z.number().int().nonnegative(),
  stopping: z.boolean(),
  components: z.array(lifecycleComponentSchema).max(256),
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.components.map(component => component.component)).size !== snapshot.components.length)
    context.addIssue({ code: 'custom', message: 'Duplicate lifecycle component' })
})
export const serviceLifecycleChangeSchema = z.object({
  snapshot: serviceLifecycleSnapshotSchema,
  component: lifecycleComponentSchema.optional(),
}).strict().superRefine((change, context) => {
  if (change.component && !change.snapshot.components.some(component => JSON.stringify(component) === JSON.stringify(change.component)))
    context.addIssue({ code: 'custom', message: 'Lifecycle change does not match its snapshot' })
})
export const rendererLifecycleReportSchema = z.object({
  generation: lifecycleIdentitySchema,
  change: serviceLifecycleChangeSchema,
}).strict()

export type LifecycleComponent = EventSnapshot<z.infer<typeof lifecycleComponentSchema>>
export type ServiceLifecycleSnapshot = EventSnapshot<z.infer<typeof serviceLifecycleSnapshotSchema>>
export type ServiceLifecycleChange = EventSnapshot<z.infer<typeof serviceLifecycleChangeSchema>>
export type RendererLifecycleReport = EventSnapshot<z.infer<typeof rendererLifecycleReportSchema>>

export interface ServiceLifecycleReader {
  readonly snapshot: ServiceLifecycleSnapshot
  readonly onDidChange: Event<ServiceLifecycleChange>
}
