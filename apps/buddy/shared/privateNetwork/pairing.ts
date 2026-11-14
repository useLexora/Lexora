import { z } from 'zod'
import { productIdSchema as id, productRevisionSchema as revision } from '../productProtocol/scalars'

export const privateNetworkSecretSchema = z.string().regex(/^[\w-]{43}$/)
export const privateNetworkPinSchema = z.string().regex(/^sha256\/[A-Za-z\d+/]{43}=$/)
export const privateNetworkEndpointSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && url.origin === value
  }
  catch { return false }
})
export const pairingContextSchema = z.object({ serviceId: id, profileId: id, issuerInstanceId: id, ticketId: id, ticketSecret: privateNetworkSecretSchema }).strict()
export const pairingQrSchema = pairingContextSchema.extend({ format: z.literal('lexora-pairing'), version: z.literal(1), endpoint: privateNetworkEndpointSchema, spkiPin: privateNetworkPinSchema, expiresAt: z.iso.datetime() }).strict()
export const pairingPrepareSchema = pairingContextSchema.extend({ deviceName: z.string().trim().min(1).max(80) }).strict()
export const pairingPrepareResultSchema = z.object({ attemptId: id, recoverySecret: privateNetworkSecretSchema, expiresAt: z.iso.datetime() }).strict()
export const pairingRecoverySchema = z.object({ serviceId: id, profileId: id, attemptId: id, recoverySecret: privateNetworkSecretSchema }).strict()
export const pairingRedeemSchema = pairingContextSchema.extend({ attemptId: id, recoverySecret: privateNetworkSecretSchema }).strict()
export const deviceCredentialSchema = z.object({ deviceId: id, credentialId: id, credentialSecret: privateNetworkSecretSchema, grantGeneration: revision, expiresAt: z.iso.datetime(), absoluteExpiresAt: z.iso.datetime() }).strict()
export const deviceStateSchema = z.object({ deviceId: id, name: z.string().max(80), state: z.enum(['pending', 'active', 'revoked', 'expired']), grantGeneration: revision, createdAt: z.iso.datetime(), confirmedAt: z.iso.datetime().nullable(), lastSeenAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime(), absoluteExpiresAt: z.iso.datetime() }).strict()
export const pairingConfirmSchema = z.object({}).strict()
export const PRIVATE_NETWORK_ROUTES = {
  prepare: { path: '/v1/pairing/prepare', input: pairingPrepareSchema, output: pairingPrepareResultSchema },
  redeem: { path: '/v1/pairing/redeem', input: pairingRedeemSchema, output: deviceCredentialSchema },
  recover: { path: '/v1/pairing/recover', input: pairingRecoverySchema, output: deviceCredentialSchema },
  confirm: { path: '/v1/pairing/confirm', input: pairingConfirmSchema, output: deviceStateSchema },
} as const
export const privateNetworkErrorSchema = z.object({ error: z.enum(['INVALID_REQUEST', 'NOT_AUTHORIZED', 'PAIRING_UNAVAILABLE', 'PAIRING_USED', 'RECOVERY_REQUIRED', 'RECOVERY_CLOSED', 'LIMIT_EXCEEDED', 'STORAGE_UNAVAILABLE', 'TLS_IDENTITY_UNAVAILABLE', 'RESOURCE_UNAVAILABLE', 'RANGE_INVALID', 'VERSION_CHANGED', 'UPLOAD_CONFLICT']) }).strict()
export type PrivateNetworkErrorCode = z.infer<typeof privateNetworkErrorSchema>['error']
export class PrivateNetworkError extends Error {
  readonly code: PrivateNetworkErrorCode

  constructor(code: PrivateNetworkErrorCode) {
    super(code)
    this.code = code
  }
}
export function deviceBearer(credential: z.infer<typeof deviceCredentialSchema>): string {
  return `${credential.credentialId}.${credential.credentialSecret}`
}
