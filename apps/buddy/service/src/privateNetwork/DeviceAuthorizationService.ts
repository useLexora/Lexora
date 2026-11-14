import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { TrustedProductContext } from '../../../shared/productProtocol/identity'
import type { TrustedCommandPrincipal } from '../commands/CommandAdmissionService'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { PRIVATE_NETWORK_LIMITS as limits } from '../../../shared/privateNetwork/limits'
import { deviceCredentialSchema, deviceStateSchema, pairingPrepareResultSchema, pairingPrepareSchema, pairingQrSchema, pairingRecoverySchema, pairingRedeemSchema, PrivateNetworkError } from '../../../shared/privateNetwork/pairing'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { CommandAdmissionError } from '../commands/CommandAdmissionError'
import { requireSqliteAuthority } from '../storage/sqliteAuthority'
import { afterTransactionCommit, withTransaction } from '../storage/transaction'

type Row = Record<string, string | number | bigint | Uint8Array | null>
export interface AuthenticatedDevice {
  deviceId: string
  credentialId: string
  grantGeneration: string
  ownerPrincipalId: string
  dataGeneration: string
}

export class DeviceAuthorizationService {
  readonly #database: DatabaseSync
  readonly #identity: { serviceId: string, profileId: string, serviceInstanceId: string }
  readonly #clock: () => number
  readonly #invalidated = new Emitter<{ deviceId: string }>(() => {})
  readonly onDidInvalidate = this.#invalidated.event
  #observed = 0

  constructor(options: { database: DatabaseSync, serviceId: string, profileId: string, serviceInstanceId: string, clock?: () => number }) {
    this.#database = options.database
    this.#identity = options
    this.#clock = options.clock ?? Date.now
    requireSqliteAuthority(this.#database)
    this.sweep()
    withTransaction(this.#database, () => this.#database.prepare('UPDATE pairing_tickets SET state = \'cancelled\' WHERE state = \'pending\' AND issuer_instance_id != ?').run(options.serviceInstanceId))
  }

  issue(endpoint: string, spkiPin: string) {
    this.sweep()
    return withTransaction(this.#database, () => {
      const now = this.#now()
      const ticketId = randomUUID()
      const ticketSecret = secret()
      const result = pairingQrSchema.parse({ format: 'lexora-pairing', version: 1, serviceId: this.#identity.serviceId, profileId: this.#identity.profileId, issuerInstanceId: this.#identity.serviceInstanceId, endpoint, spkiPin, ticketId, ticketSecret, expiresAt: iso(now + limits.ticketLifetimeMs) })
      this.#database.prepare('UPDATE pairing_tickets SET state = \'cancelled\' WHERE state = \'pending\'').run()
      this.#database.prepare('INSERT INTO pairing_tickets(id,secret_hash,issuer_instance_id,state,expires_ms) VALUES (?,?,?,\'pending\',?)').run(ticketId, hash(ticketSecret), this.#identity.serviceInstanceId, now + limits.ticketLifetimeMs)
      return result
    })
  }

  cancelTicket(ticketId?: string): void {
    withTransaction(this.#database, () => this.#database.prepare('UPDATE pairing_tickets SET state = \'cancelled\' WHERE state = \'pending\' AND (? IS NULL OR id = ?)').run(ticketId ?? null, ticketId ?? null))
  }

  prepare(raw: unknown) {
    const input = pairingPrepareSchema.parse(raw)
    this.sweep()
    return withTransaction(this.#database, () => {
      this.#ticket(input)
      const now = this.#now()
      if (Number(this.#database.prepare('SELECT count(*) AS n FROM pairing_attempts WHERE closed_ms IS NULL').get()!.n) >= limits.pendingAttempts)
        throw new PrivateNetworkError('LIMIT_EXCEEDED')
      const attemptId = randomUUID()
      const recoverySecret = secret()
      const expires = now + limits.recoveryLifetimeMs
      this.#database.prepare('INSERT INTO pairing_attempts(id,ticket_id,recovery_hash,device_name,expires_ms) VALUES (?,?,?,?,?)').run(attemptId, input.ticketId, hash(recoverySecret), input.deviceName, expires)
      return pairingPrepareResultSchema.parse({ attemptId, recoverySecret, expiresAt: iso(expires) })
    })
  }

  redeem(raw: unknown) {
    const input = pairingRedeemSchema.parse(raw)
    this.sweep()
    return withTransaction(this.#database, () => {
      this.#context(input)
      const attempt = this.#attempt(input.attemptId, input.recoverySecret)
      if (attempt.ticket_id !== input.ticketId)
        throw new PrivateNetworkError('NOT_AUTHORIZED')
      if (attempt.device_id)
        throw new PrivateNetworkError('RECOVERY_REQUIRED')
      const ticket = this.#ticket(input)
      if (Number(this.#database.prepare('SELECT count(*) AS n FROM remote_devices WHERE state IN (\'pending\',\'active\')').get()!.n) >= limits.devices)
        throw new PrivateNetworkError('LIMIT_EXCEEDED')
      const now = this.#now()
      const deviceId = randomUUID()
      const profile = this.#profile()
      this.#database.prepare('INSERT INTO storage_actors(id,kind,state,created_at) VALUES (?,\'device\',\'active\',?)').run(deviceId, iso(now))
      this.#database.prepare('INSERT INTO remote_devices(id,owner_actor_id,data_generation,state,name,created_ms,pending_expires_ms,idle_expires_ms,absolute_expires_ms) VALUES (?,?,?,\'pending\',?,?,?,?,?)').run(deviceId, String(profile.local_actor_id), String(profile.data_generation), String(attempt.device_name), now, Number(attempt.expires_ms), now + limits.credentialIdleMs, now + limits.credentialAbsoluteMs)
      this.#database.prepare('UPDATE pairing_attempts SET device_id = ? WHERE id = ?').run(deviceId, input.attemptId)
      this.#database.prepare('UPDATE pairing_tickets SET state = \'consumed\', attempt_id = ? WHERE id = ? AND state = \'pending\'').run(input.attemptId, String(ticket.id))
      return this.#issueCredential(input.attemptId, this.#device(deviceId)!)
    })
  }

  recover(raw: unknown) {
    const input = pairingRecoverySchema.parse(raw)
    this.sweep()
    return withTransaction(this.#database, () => {
      this.#context(input)
      const attempt = this.#attempt(input.attemptId, input.recoverySecret)
      const device = attempt.device_id ? this.#device(String(attempt.device_id)) : null
      if (!device || device.state !== 'pending' || device.data_generation !== this.#profile().data_generation)
        throw new PrivateNetworkError('RECOVERY_CLOSED')
      if (Number(attempt.credential_count) >= limits.siblingCredentials)
        throw new PrivateNetworkError('LIMIT_EXCEEDED')
      return this.#issueCredential(input.attemptId, device)
    })
  }

  confirm(bearer: string) {
    this.sweep()
    return withTransaction(this.#database, () => {
      const { device } = this.#credential(bearer, true)
      if (device.state === 'pending') {
        const now = this.#now()
        this.#database.prepare('UPDATE remote_devices SET state = \'active\', confirmed_ms = ?, last_seen_ms = ? WHERE id = ? AND state = \'pending\'').run(now, now, String(device.id))
        this.#database.prepare('UPDATE pairing_attempts SET closed_ms = ? WHERE device_id = ? AND closed_ms IS NULL').run(now, String(device.id))
      }
      return this.#publicDevice(this.#device(String(device.id))!)
    })
  }

  authenticate(bearer: string): AuthenticatedDevice {
    this.sweep()
    const { credential, device } = this.#credential(bearer, false)
    return { deviceId: String(device.id), credentialId: String(credential.id), grantGeneration: encodeProductRevision(Number(device.grant_generation)), ownerPrincipalId: String(device.owner_actor_id), dataGeneration: String(device.data_generation) }
  }

  assertCurrent(identity: AuthenticatedDevice): void {
    this.sweep()
    const device = this.#device(identity.deviceId)
    const credential = this.#database.prepare('SELECT * FROM remote_credentials WHERE id = ? AND device_id = ?').get(identity.credentialId, identity.deviceId)
    if (!device || !credential || device.state !== 'active' || encodeProductRevision(Number(device.grant_generation)) !== identity.grantGeneration || Number(credential.grant_generation) !== Number(device.grant_generation) || device.owner_actor_id !== identity.ownerPrincipalId || device.data_generation !== identity.dataGeneration || device.data_generation !== this.#profile().data_generation)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
  }

  principal(identity: AuthenticatedDevice): TrustedCommandPrincipal {
    return Object.freeze({ actorId: identity.deviceId, assertAuthenticated: () => {
      try {
        this.assertCurrent(identity)
      }
      catch { throw new CommandAdmissionError('COMMAND_ACTOR_UNAVAILABLE') }
    } })
  }

  context(identity: AuthenticatedDevice): TrustedProductContext {
    this.assertCurrent(identity)
    return { ...identity, ...this.#identity, connectionId: randomUUID(), clientSessionId: randomUUID(), role: 'owner' }
  }

  state(bearer: string) {
    const identity = this.authenticate(bearer)
    return this.#publicDevice(this.#device(identity.deviceId)!)
  }

  renew(bearer: string) {
    const identity = this.authenticate(bearer)
    return withTransaction(this.#database, () => {
      this.assertCurrent(identity)
      const now = this.#now()
      this.#database.prepare('UPDATE remote_devices SET last_seen_ms = ?, idle_expires_ms = MIN(absolute_expires_ms, ?) WHERE id = ?').run(now, now + limits.credentialIdleMs, identity.deviceId)
      return this.#publicDevice(this.#device(identity.deviceId)!)
    })
  }

  revoke(deviceId: string): void {
    this.sweep()
    withTransaction(this.#database, () => {
      const device = this.#device(deviceId)
      if (!device)
        throw new PrivateNetworkError('NOT_AUTHORIZED')
      if (device.state === 'revoked' || device.state === 'expired')
        return
      this.#invalidate(deviceId, 'revoked', this.#now())
    })
  }

  revokeAll(): void {
    withTransaction(this.#database, () => {
      for (const row of this.#database.prepare('SELECT id FROM remote_devices WHERE state IN (\'pending\',\'active\')').all()) this.#invalidate(String(row.id), 'revoked', this.#now())
      this.cancelTicket()
    })
  }

  list(): z.infer<typeof deviceStateSchema>[] {
    this.sweep()
    return this.#database.prepare('SELECT * FROM remote_devices ORDER BY created_ms DESC LIMIT 256').all().map(row => this.#publicDevice(row))
  }

  sweep(): void {
    withTransaction(this.#database, () => {
      const now = this.#now()
      this.#database.prepare('UPDATE pairing_tickets SET state = \'expired\' WHERE state = \'pending\' AND expires_ms <= ?').run(now)
      this.#database.prepare('UPDATE pairing_attempts SET closed_ms = ? WHERE closed_ms IS NULL AND expires_ms <= ?').run(now, now)
      const rows = this.#database.prepare('SELECT id FROM remote_devices WHERE state IN (\'pending\',\'active\') AND (data_generation != ? OR absolute_expires_ms <= ? OR idle_expires_ms <= ? OR (state = \'pending\' AND pending_expires_ms <= ?))').all(String(this.#profile().data_generation), now, now, now)
      for (const row of rows) this.#invalidate(String(row.id), 'expired', now)
    })
  }

  #invalidate(deviceId: string, state: 'expired' | 'revoked', now: number) {
    this.#database.prepare('UPDATE remote_devices SET state = ?, grant_generation = grant_generation + 1 WHERE id = ?').run(state, deviceId)
    this.#database.prepare('UPDATE storage_actors SET state = \'revoked\' WHERE id = ?').run(deviceId)
    this.#database.prepare('UPDATE pairing_attempts SET closed_ms = COALESCE(closed_ms, ?) WHERE device_id = ?').run(now, deviceId)
    afterTransactionCommit(this.#database, () => this.#invalidated.fire({ deviceId }), () => {})
  }

  #credential(bearer: string, allowPending: boolean) {
    const match = /^([\w-]{1,128})\.([\w-]{43})$/.exec(bearer)
    if (!match)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
    const credential = this.#database.prepare('SELECT * FROM remote_credentials WHERE id = ?').get(match[1]!)
    const device = credential ? this.#device(String(credential.device_id)) : null
    if (!credential || !device || !matches(String(credential.secret_hash), match[2]!) || (device.state !== 'active' && !(allowPending && device.state === 'pending')) || Number(credential.grant_generation) !== Number(device.grant_generation) || device.data_generation !== this.#profile().data_generation)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
    return { credential, device }
  }

  #issueCredential(attemptId: string, device: Row) {
    const now = this.#now()
    const credentialId = randomUUID()
    const credentialSecret = secret()
    this.#database.prepare('INSERT INTO remote_credentials(id,device_id,secret_hash,grant_generation,created_ms) VALUES (?,?,?,?,?)').run(credentialId, String(device.id), hash(credentialSecret), Number(device.grant_generation), now)
    this.#database.prepare('UPDATE pairing_attempts SET credential_count = credential_count + 1 WHERE id = ?').run(attemptId)
    return deviceCredentialSchema.parse({ deviceId: device.id, credentialId, credentialSecret, grantGeneration: encodeProductRevision(Number(device.grant_generation)), expiresAt: iso(Number(device.idle_expires_ms)), absoluteExpiresAt: iso(Number(device.absolute_expires_ms)) })
  }

  #attempt(id: string, recovery: string) {
    const attempt = this.#database.prepare('SELECT * FROM pairing_attempts WHERE id = ?').get(id)
    if (!attempt || !matches(String(attempt.recovery_hash), recovery))
      throw new PrivateNetworkError('NOT_AUTHORIZED')
    if (attempt.closed_ms !== null || Number(attempt.expires_ms) <= this.#now())
      throw new PrivateNetworkError('RECOVERY_CLOSED')
    return attempt
  }

  #ticket(input: { serviceId: string, profileId: string, issuerInstanceId: string, ticketId: string, ticketSecret: string }) {
    this.#context(input)
    const ticket = this.#database.prepare('SELECT * FROM pairing_tickets WHERE id = ?').get(input.ticketId)
    if (!ticket || !matches(String(ticket.secret_hash), input.ticketSecret) || ticket.issuer_instance_id !== this.#identity.serviceInstanceId || input.issuerInstanceId !== ticket.issuer_instance_id || Number(ticket.expires_ms) <= this.#now())
      throw new PrivateNetworkError('PAIRING_UNAVAILABLE')
    if (ticket.state !== 'pending')
      throw new PrivateNetworkError(ticket.state === 'consumed' ? 'PAIRING_USED' : 'PAIRING_UNAVAILABLE')
    return ticket
  }

  #context(input: { serviceId: string, profileId: string }) {
    if (input.serviceId !== this.#identity.serviceId || input.profileId !== this.#identity.profileId)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
  }

  #now(): number {
    this.#observed = Math.max(this.#observed, this.#clock(), Number(this.#database.prepare('SELECT last_observed_ms FROM private_network_state WHERE id = 1').get()!.last_observed_ms))
    this.#database.prepare('UPDATE private_network_state SET last_observed_ms = ? WHERE id = 1 AND last_observed_ms < ?').run(this.#observed, this.#observed)
    return this.#observed
  }

  #profile() { return this.#database.prepare('SELECT * FROM storage_profile WHERE id = 1').get()! }
  #device(id: string) { return this.#database.prepare('SELECT * FROM remote_devices WHERE id = ?').get(id) }
  #publicDevice(device: Row) {
    return deviceStateSchema.parse({ deviceId: device.id, name: device.name, state: device.state, grantGeneration: encodeProductRevision(Number(device.grant_generation)), createdAt: iso(Number(device.created_ms)), confirmedAt: device.confirmed_ms === null ? null : iso(Number(device.confirmed_ms)), lastSeenAt: device.last_seen_ms === null ? null : iso(Number(device.last_seen_ms)), expiresAt: iso(Number(device.idle_expires_ms)), absoluteExpiresAt: iso(Number(device.absolute_expires_ms)) })
  }
}
function secret() {
  return randomBytes(32).toString('base64url')
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function matches(expected: string, value: string): boolean {
  const actual = hash(value)
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}
function iso(value: number) {
  return new Date(value).toISOString()
}
