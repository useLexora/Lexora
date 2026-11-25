import type { DatabaseSync } from 'node:sqlite'

export function completeDeviceProfileSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS remote_device_profiles (
      device_id TEXT PRIMARY KEY REFERENCES remote_devices(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
      manufacturer TEXT,
      model TEXT,
      os_version TEXT,
      app_version TEXT NOT NULL
    ) STRICT
  `)
}
