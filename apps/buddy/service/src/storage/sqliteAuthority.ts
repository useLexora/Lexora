import type { DatabaseSync } from 'node:sqlite'
import { BUDDY_STORAGE_WRITER_VERSION } from './schema'

export function requireSqliteAuthority(database: DatabaseSync): { dataGeneration: string } {
  const profile = database.prepare(`
    SELECT data_generation, authority, migration_state, min_writer_version
    FROM storage_profile WHERE id = 1
  `).get()
  if (!profile || profile.authority !== 'sqlite' || profile.migration_state !== 'ready'
    || typeof profile.data_generation !== 'string'
    || typeof profile.min_writer_version !== 'number'
    || profile.min_writer_version > BUDDY_STORAGE_WRITER_VERSION) {
    throw new Error('SQLite storage authority is not ready for this writer')
  }
  return { dataGeneration: profile.data_generation }
}
