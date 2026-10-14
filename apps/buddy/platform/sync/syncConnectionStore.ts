import { z } from 'zod'
import { s3ConnectionSchema, webDavConnectionSchema } from '../../shared/sync/syncApi'

const credentialField = { credentialId: z.uuid() }
export const syncConnectionStoreSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().optional(),
  selectedAdapter: z.enum(['webdav', 's3']).optional(),
  activeConnectionId: z.uuid().nullable().optional(),
  connections: z.array(z.discriminatedUnion('adapter', [webDavConnectionSchema.extend(credentialField), s3ConnectionSchema.extend(credentialField)])).max(32),
}).strict()

export function mergeRestoredSyncConnections(current: unknown, incoming: unknown) {
  const restored = syncConnectionStoreSchema.parse(incoming)
  const saved = current === null ? null : syncConnectionStoreSchema.parse(current)
  const connections = new Map((saved?.connections ?? []).map(item => [item.id, item]))
  for (const connection of restored.connections)
    connections.set(connection.id, connection)
  return syncConnectionStoreSchema.parse({
    ...restored,
    ...saved,
    enabled: saved?.enabled ?? false,
    connections: [...connections.values()],
  })
}
