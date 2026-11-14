import type { DatabaseSync } from 'node:sqlite'

export function sanitizeRestoredDatabase(database: DatabaseSync, preserveCredentials = false): void {
  const persistence = Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'storage_profile\'').get())
  database.exec('PRAGMA secure_delete = ON; BEGIN IMMEDIATE')
  try {
    database.exec(`
      UPDATE automations SET status = 'paused', next_run_at = NULL;
      UPDATE automation_occurrences
        SET status = 'cancelled', finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'DATA_RESTORE_SKIPPED', error_summary = NULL
        WHERE status = 'queued' AND run_id IS NULL;
      UPDATE conversation_directory_grants SET revoked_at = datetime('now');
      UPDATE space_directory_bindings SET revoked_at = datetime('now'), resources_trusted_at = NULL;
      UPDATE mcp_servers SET enabled = 0, trusted_at = NULL;
      UPDATE extension_capabilities SET state = 'unavailable',
        unavailable_reason = CASE WHEN kind = 'subagent' THEN 'dependency_unavailable' ELSE NULL END,
        user_enabled = CASE WHEN kind = 'mcp' THEN 0 ELSE user_enabled END;
      ${preserveCredentials ? '' : 'UPDATE mcp_servers SET credential_ref = NULL; UPDATE provider_configs SET credential_ref = NULL;'}
      UPDATE provider_states SET request_headers_json = '[]';
      UPDATE skill_installations SET enabled = 0;
      ${persistence ? 'UPDATE chat_queue SET state = \'paused\' WHERE state = \'waiting\'; UPDATE file_preparations SET state = CASE WHEN EXISTS (SELECT 1 FROM file_references WHERE file_id = file_preparations.id) THEN \'settled\' ELSE \'aborted\' END, reserved_bytes = 0; DELETE FROM file_references WHERE kind = \'export\'; DELETE FROM service_admission_gates;' : 'DELETE FROM chat_queue;'}
      COMMIT;
    `)
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
