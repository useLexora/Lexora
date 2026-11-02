import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './database'

export interface ProviderResolutionRepository {
  find: (providerId: string) => string | null
  remove: (providerId: string) => void
  commit: (providerId: string, inputFingerprint: string, operation: () => void) => void
}

export function createProviderResolutionRepository(database: DatabaseSync): ProviderResolutionRepository {
  const find = database.prepare('SELECT input_fingerprint FROM provider_resolution_checkpoints WHERE provider_id = ?')
  const remove = database.prepare('DELETE FROM provider_resolution_checkpoints WHERE provider_id = ?')
  const upsert = database.prepare('INSERT INTO provider_resolution_checkpoints (provider_id, input_fingerprint) VALUES (?, ?) ON CONFLICT (provider_id) DO UPDATE SET input_fingerprint = excluded.input_fingerprint')
  return {
    find: providerId => (find.get(providerId) as { input_fingerprint: string } | undefined)?.input_fingerprint ?? null,
    remove: (providerId) => { remove.run(providerId) },
    commit(providerId, inputFingerprint, operation) {
      withTransaction(database, () => {
        remove.run(providerId)
        operation()
        upsert.run(providerId, inputFingerprint)
      })
    },
  }
}
