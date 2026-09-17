import { z } from 'zod'

export const contextPanelSourceSchema = z.object({
  conversationId: z.string().min(1).max(128),
  runId: z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i),
}).strict()

export const contextPanelTargetSchema = z.object({
  kind: z.literal('browser'),
  source: contextPanelSourceSchema,
}).strict()

export const contextPanelCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), target: contextPanelTargetSchema.nullable().optional(), source: contextPanelSourceSchema.nullable().optional() }).strict(),
  z.object({ action: z.literal('close'), source: contextPanelSourceSchema.nullable().optional() }).strict(),
])

export const contextPanelStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  open: z.boolean(),
  target: contextPanelTargetSchema.nullable(),
}).strict()

export type ContextPanelCommand = z.infer<typeof contextPanelCommandSchema>
export type ContextPanelState = z.infer<typeof contextPanelStateSchema>
export type ContextPanelSource = z.infer<typeof contextPanelSourceSchema>

export const contextPanelOperationSchema = z.object({
  action: z.enum(['open', 'close']),
  actor: z.enum(['harness', 'user']),
}).strict()

export const contextPanelOperationRecordSchema = contextPanelOperationSchema.extend({
  source: contextPanelSourceSchema,
  createdAt: z.iso.datetime(),
}).strict()

export type ContextPanelOperation = z.infer<typeof contextPanelOperationSchema>
export type ContextPanelOperationRecord = z.infer<typeof contextPanelOperationRecordSchema>

export const contextPanelRpc = {
  presentBrowser: 'host.contextPanel.presentBrowser',
  recordOperation: 'contextPanel.recordOperation',
} as const

export interface ContextPanelApi {
  getState: () => Promise<ContextPanelState>
  execute: (command: ContextPanelCommand) => Promise<ContextPanelState>
  onStateChanged: (listener: (state: ContextPanelState) => void) => () => void
}
