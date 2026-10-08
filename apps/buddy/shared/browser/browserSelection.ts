import { z } from 'zod'

export const browserElementSnapshotSchema = z.object({
  tagName: z.string().regex(/^[a-z][a-z0-9-]*$/).max(80),
  selector: z.string().min(1).max(2048),
  role: z.string().max(128),
  name: z.string().max(512),
  rect: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict(),
  style: z.object({ color: z.string().max(256), backgroundColor: z.string().max(256), fontSize: z.string().max(64), fontFamily: z.string().max(512) }).strict(),
}).strict().readonly()
export type BrowserElementSnapshot = z.infer<typeof browserElementSnapshotSchema>
export const browserSelectionSourceSchema = z.object({
  kind: z.literal('browser'),
  title: z.string().trim().min(1).max(512),
  url: z.string().max(8192).refine((value) => {
    try {
      return ['http:', 'https:', 'file:'].includes(new URL(value).protocol)
    }
    catch { return false }
  }),
  sessionId: z.string().min(1).max(128),
  pageId: z.string().min(1).max(128),
  documentVersion: z.number().int().nonnegative(),
}).strict().readonly()
export const browserPickInputSchema = z.object({ sessionId: z.string().min(1).max(128), requestId: z.string().uuid() }).strict()
/** Normalized guest viewport coordinates, used only to position the current picker menu. */
export const browserElementPickAnchorSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().readonly()
export type BrowserElementPickAnchor = z.infer<typeof browserElementPickAnchorSchema>
export const browserPickResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('selected'), text: z.string().min(1).max(32768), element: browserElementSnapshotSchema, source: browserSelectionSourceSchema, anchor: browserElementPickAnchorSchema }).strict(),
  z.object({ status: z.enum(['cancelled', 'limit', 'unavailable']) }).strict(),
])
export type BrowserPickResult = z.infer<typeof browserPickResultSchema>
export const browserLocateElementInputSchema = z.object({ source: browserSelectionSourceSchema, element: browserElementSnapshotSchema, text: z.string().min(1).max(32768) }).strict()
export type BrowserLocateElementInput = z.infer<typeof browserLocateElementInputSchema>
