import { z } from 'zod'

export const extensionSettingsHeaderActionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][\w.-]*$/i),
  title: z.string().trim().min(1).max(40).refine(value => !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), 'Expected a single-line title'),
  icon: z.enum(['settings', 'download', 'refresh', 'add', 'back', 'more']).optional(),
  disabled: z.boolean().optional(),
  progress: z.number().min(0).max(100).nullable().optional(),
}).strict()
export const extensionSettingsHeaderActionsSchema = z.array(extensionSettingsHeaderActionSchema).max(4).refine(actions => new Set(actions.map(action => action.id)).size === actions.length, 'Header action IDs must be unique')
export type ExtensionSettingsHeaderAction = z.infer<typeof extensionSettingsHeaderActionSchema>
