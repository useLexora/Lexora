export const PRIVATE_NETWORK_TABLE_COLUMNS = {
  private_network_state: ['id', 'enabled', 'bind_address', 'port', 'tls_pin', 'last_observed_ms'],
  pairing_tickets: ['id', 'secret_hash', 'issuer_instance_id', 'state', 'expires_ms', 'attempt_id'],
  pairing_attempts: ['id', 'ticket_id', 'recovery_hash', 'device_name', 'expires_ms', 'device_id', 'closed_ms', 'credential_count'],
  remote_devices: ['id', 'owner_actor_id', 'data_generation', 'state', 'grant_generation', 'created_ms', 'confirmed_ms', 'last_seen_ms', 'pending_expires_ms', 'idle_expires_ms', 'absolute_expires_ms'],
  remote_credentials: ['id', 'device_id', 'secret_hash', 'grant_generation', 'created_ms'],
} as const
export const PRIVATE_NETWORK_TRIGGER_NAMES = ['remote_devices_terminal', 'remote_devices_generation', 'remote_credentials_immutable', 'pairing_ticket_terminal'] as const
export const PRIVATE_NETWORK_SCHEMA_SQL = `
CREATE TABLE private_network_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  bind_address TEXT,
  port INTEGER CHECK (port BETWEEN 1 AND 65535),
  tls_pin TEXT,
  last_observed_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_observed_ms >= 0)
) STRICT;
INSERT INTO private_network_state(id) VALUES (1);
CREATE TABLE pairing_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  issuer_instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','consumed','cancelled','expired')),
  expires_ms INTEGER NOT NULL,
  attempt_id TEXT
) STRICT;
CREATE UNIQUE INDEX pairing_tickets_pending ON pairing_tickets(state) WHERE state = 'pending';
CREATE TABLE pairing_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES pairing_tickets(id),
  recovery_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  device_id TEXT,
  closed_ms INTEGER,
  credential_count INTEGER NOT NULL DEFAULT 0 CHECK (credential_count BETWEEN 0 AND 5)
) STRICT;
CREATE TABLE remote_devices (
  id TEXT PRIMARY KEY NOT NULL REFERENCES storage_actors(id),
  owner_actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  data_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','active','revoked','expired')),
  name TEXT NOT NULL,
  grant_generation INTEGER NOT NULL DEFAULT 1 CHECK (grant_generation >= 1),
  created_ms INTEGER NOT NULL,
  confirmed_ms INTEGER,
  last_seen_ms INTEGER,
  pending_expires_ms INTEGER NOT NULL,
  idle_expires_ms INTEGER NOT NULL,
  absolute_expires_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE remote_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES remote_devices(id),
  secret_hash TEXT NOT NULL UNIQUE,
  grant_generation INTEGER NOT NULL,
  created_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX remote_credentials_device ON remote_credentials(device_id);
CREATE TRIGGER remote_devices_terminal BEFORE UPDATE OF state ON remote_devices
WHEN (OLD.state IN ('revoked','expired') AND NEW.state != OLD.state) OR (OLD.state = 'active' AND NEW.state = 'pending')
BEGIN SELECT RAISE(ABORT, 'DEVICE_STATE_TERMINAL'); END;
CREATE TRIGGER remote_devices_generation BEFORE UPDATE OF grant_generation ON remote_devices
WHEN NEW.grant_generation < OLD.grant_generation
BEGIN SELECT RAISE(ABORT, 'DEVICE_GENERATION_REGRESSION'); END;
CREATE TRIGGER remote_credentials_immutable BEFORE UPDATE ON remote_credentials
BEGIN SELECT RAISE(ABORT, 'CREDENTIAL_IMMUTABLE'); END;
CREATE TRIGGER pairing_ticket_terminal BEFORE UPDATE OF state ON pairing_tickets
WHEN OLD.state != 'pending' AND NEW.state != OLD.state
BEGIN SELECT RAISE(ABORT, 'PAIRING_TICKET_TERMINAL'); END;
`
