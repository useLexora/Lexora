import { z } from 'zod'

export const workbenchAnchorSchema = z.enum(['app.sidebar', 'workbench.sidebar', 'workbench.pane', 'composer.input'])
export const workbenchControlSchema = z.enum(['model.reasoning'])
export const workbenchMountTargetSchema = z.enum(['workbench', 'app.sidebar', 'workbench.sidebar'])
const mountLengthSchema = z.union([z.number().min(0).max(8192), z.string().regex(/^(?:100|\d{1,2})(?:\.\d{1,3})?%$/).refine(value => Number.parseFloat(value) <= 100)])
export const workbenchPresentationSchema = z.object({
  target: workbenchMountTargetSchema.optional(),
  position: z.enum(['static', 'absolute']).optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
  zIndex: z.number().int().min(0).max(20).optional(),
  width: mountLengthSchema.nullable().optional(),
  height: mountLengthSchema.nullable().optional(),
  top: mountLengthSchema.nullable().optional(),
  right: mountLengthSchema.nullable().optional(),
  bottom: mountLengthSchema.nullable().optional(),
  left: mountLengthSchema.nullable().optional(),
}).strict()
export const extensionPresentationRequestSchema = workbenchPresentationSchema
export type WorkbenchPresentation = z.infer<typeof workbenchPresentationSchema>
export type WorkbenchMountTarget = z.infer<typeof workbenchMountTargetSchema>
export type WorkbenchAnchor = z.infer<typeof workbenchAnchorSchema>
export type WorkbenchControl = z.infer<typeof workbenchControlSchema>

export interface MountGeometry {
  target: WorkbenchMountTarget
  visible: boolean
  width: number
  height: number
  rect: { x: number, y: number, width: number, height: number }
}
export interface ControlSnapshot {
  revision: string
  value: string | null
  options: readonly { value: string, label: string }[]
  disabled: boolean
}
export const controlProposalSchema = z.object({ revision: z.string().uuid(), value: z.string().max(80) }).strict()
export type ControlProposal = z.infer<typeof controlProposalSchema>
export interface AnchorGeometry {
  kind: WorkbenchAnchor
  visible: boolean
  width: number
  height: number
}
export interface ComposerActivity {
  type: 'composer-input'
  caret: { x: number, y: number, width: number, height: number } | null
}
