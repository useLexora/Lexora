import type { FileIconThemeSnapshot } from './fileIconTheme'
import { z } from 'zod'
import { fileIconPreferenceSchema } from './fileIconTheme'

export const FILE_ICON_IPC = { request: 'lexora:icons:request', changed: 'lexora:icons:changed', initial: 'lexora:icons:initial' } as const
export const fileIconThemeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('active') }).strict(),
  z.object({ action: z.literal('preference'), preference: fileIconPreferenceSchema }).strict(),
])
export type FileIconThemeRequest = z.input<typeof fileIconThemeRequestSchema>
export interface FileIconThemeApi {
  initial: FileIconThemeSnapshot
  request: (input: FileIconThemeRequest) => Promise<FileIconThemeSnapshot>
  onDidChange: (listener: (snapshot: FileIconThemeSnapshot) => void) => () => void
}
