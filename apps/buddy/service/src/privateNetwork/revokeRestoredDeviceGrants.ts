import type { DatabaseSync } from 'node:sqlite'

export function revokeRestoredDeviceGrants(database: DatabaseSync, now = Date.now()): void {
  if (!database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'remote_devices\'').get())
    return
  database.prepare('UPDATE remote_devices SET state = \'revoked\', grant_generation = grant_generation + 1 WHERE state IN (\'pending\',\'active\')').run()
  database.prepare('UPDATE storage_actors SET state = \'revoked\' WHERE kind = \'device\'').run()
  database.prepare('UPDATE pairing_attempts SET closed_ms = COALESCE(closed_ms, ?)').run(now)
  database.prepare('UPDATE pairing_tickets SET state = \'cancelled\' WHERE state = \'pending\'').run()
  if (database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'remote_uploads\'').get()) {
    database.prepare('UPDATE remote_uploads SET state = \'cancelled\' WHERE state IN (\'receiving\',\'ready\')').run()
    database.prepare('DELETE FROM file_references WHERE kind = \'export\' AND owner_id IN (SELECT id FROM remote_uploads WHERE state = \'cancelled\')').run()
  }
  if (database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'remote_exports\'').get()) {
    database.prepare('UPDATE remote_exports SET state = \'expired\' WHERE state IN (\'preparing\',\'ready\')').run()
    database.prepare('DELETE FROM file_references WHERE kind = \'export\' AND owner_id IN (SELECT id FROM remote_exports)').run()
  }
  database.prepare('UPDATE private_network_state SET last_observed_ms = MAX(last_observed_ms, ?) WHERE id = 1').run(now)
}
