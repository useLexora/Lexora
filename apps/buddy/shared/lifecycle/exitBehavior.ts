import { z } from 'zod'

export const desktopExitBehaviorSchema = z.enum(['keep_service', 'stop_service'])
export type DesktopExitBehavior = z.infer<typeof desktopExitBehaviorSchema>
export const DEFAULT_DESKTOP_EXIT_BEHAVIOR: DesktopExitBehavior = 'stop_service'
