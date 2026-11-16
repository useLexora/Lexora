import type { DatabaseSync } from 'node:sqlite'

export function completeProviderAuthenticationSchema(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(provider_configs)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'authentication'))
    database.exec('ALTER TABLE provider_configs ADD COLUMN authentication TEXT NOT NULL DEFAULT \'api_key\' CHECK (authentication IN (\'api_key\', \'none\'))')
}
