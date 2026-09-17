import { DatabaseSync } from 'node:sqlite'

export const MIGRATION_TEST_TIMEOUT = 20_000

export function openMigrationFixtureDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath)
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
  `)
  return database
}
