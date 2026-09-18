import { z } from 'zod'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const workbenchStateSchema = z.object({
  version: z.literal(1),
  layout: z.json(),
  configuration: z.record(z.string().max(256), z.union([z.string().max(2048), z.number().finite(), z.boolean()])).default({}),
  backups: z.array(z.object({
    key: z.string().max(8192),
    resource: z.json(),
    text: z.string().max(1024 * 1024),
    baseText: z.string().max(1024 * 1024),
    etag: z.string().max(256),
    savedAt: z.string().max(64),
  }).strict()).max(128),
}).strict()

export type WorkbenchState = z.infer<typeof workbenchStateSchema>

export interface WorkbenchStateApi {
  read: () => Promise<WorkbenchState | null>
  write: (state: WorkbenchState) => Promise<void>
}
