import { z } from 'zod'

export const BROWSER_ZOOM_FACTORS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
export const browserZoomFactorSchema = z.number().min(0.5).max(3)
export const browserFreezeDelaySchema = z.number().int().min(5).max(3600)
export const browserPreferencesSchema = z.object({
  screenshotDestination: z.enum(['file', 'clipboard']),
  defaultZoomFactor: browserZoomFactorSchema,
  freezeBackground: z.boolean(),
  freezeForeground: z.boolean(),
  freezeDelaySeconds: browserFreezeDelaySchema,
}).strict()

export type BrowserPreferences = z.infer<typeof browserPreferencesSchema>
export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  screenshotDestination: 'file',
  defaultZoomFactor: 1,
  freezeBackground: true,
  freezeForeground: false,
  freezeDelaySeconds: 60,
}

export function stepBrowserZoom(current: number, direction: 'in' | 'out'): number {
  return direction === 'in'
    ? BROWSER_ZOOM_FACTORS.find(value => value > current + 0.001) ?? 3
    : BROWSER_ZOOM_FACTORS.findLast(value => value < current - 0.001) ?? 0.5
}
