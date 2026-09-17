import { z } from 'zod'

export const browserClearDataInputSchema = z.object({
  siteData: z.boolean(),
  cache: z.boolean(),
}).strict().refine(input => input.siteData || input.cache)

export type BrowserClearDataInput = z.infer<typeof browserClearDataInputSchema>
export const browserDataSummarySchema = z.object({
  cacheBytes: z.number().nonnegative(),
  cookieSiteCount: z.number().int().nonnegative(),
}).strict()
export type BrowserDataSummary = z.infer<typeof browserDataSummarySchema>

export const browserClearDataResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['BROWSER_IN_USE', 'BROWSER_CLEAR_FAILED']) }).strict(),
])
export type BrowserClearDataResult = z.infer<typeof browserClearDataResultSchema>
