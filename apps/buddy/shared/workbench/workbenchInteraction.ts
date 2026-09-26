import { z } from 'zod'

export const workbenchRectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict()
export const workbenchPaneSnapshotSchema = z.object({ id: z.string().uuid(), active: z.boolean(), visible: z.boolean(), rect: workbenchRectSchema }).strict()
export const workbenchPanesSchema = z.array(workbenchPaneSnapshotSchema).max(16).refine(panes => new Set(panes.map(pane => pane.id)).size === panes.length)
export type WorkbenchPaneSnapshot = z.infer<typeof workbenchPaneSnapshotSchema>
export const workbenchHitRegionsSchema = z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), rect: workbenchRectSchema }).strict()).max(64).refine(regions => new Set(regions.map(region => region.id)).size === regions.length)
export type WorkbenchHitRegion = z.infer<typeof workbenchHitRegionsSchema>[number]
export interface WorkbenchRegionActivation { id: string, x: number, y: number }
export interface WorkbenchInteraction { id: string, title: string }
