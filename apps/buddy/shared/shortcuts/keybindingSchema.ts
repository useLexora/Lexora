import { z } from 'zod'
import { isKeybinding } from './keybinding'

export const keybindingsSchema = z.record(z.string().min(1).max(160).regex(/^[\w.-]+$/), z.string().max(80).refine(isKeybinding))
  .refine(value => Object.keys(value).length <= 500)
