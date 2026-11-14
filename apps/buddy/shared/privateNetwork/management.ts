import { z } from 'zod'
import { productIdSchema } from '../productProtocol/scalars'
import { deviceStateSchema, pairingQrSchema, privateNetworkPinSchema } from './pairing'

export const privateNetworkStatusSchema = z.object({ enabled: z.boolean(), state: z.enum(['disabled', 'listening', 'unavailable']), bindAddress: z.string().max(256).nullable(), port: z.number().int().min(0).max(65535).nullable(), endpoint: z.string().nullable(), spkiPin: privateNetworkPinSchema.nullable(), errorCode: z.enum(['CREDENTIAL_STORE_UNAVAILABLE', 'TLS_IDENTITY_UNAVAILABLE', 'ADDRESS_INVALID', 'ADDRESS_IN_USE', 'ADDRESS_UNAVAILABLE', 'LISTEN_FAILED']).nullable() }).strict()
const empty = z.object({}).strict()
const result = z.object({ ok: z.literal(true) }).strict()
export const privateNetworkManagement = {
  status: { method: 'privateNetwork.status', input: empty, response: privateNetworkStatusSchema },
  configure: { method: 'privateNetwork.configure', input: z.object({ enabled: z.boolean(), bindAddress: z.string().max(256).optional(), port: z.number().int().min(1).max(65535).optional() }).strict(), response: privateNetworkStatusSchema },
  issuePairing: { method: 'privateNetwork.issuePairing', input: empty, response: pairingQrSchema },
  cancelPairing: { method: 'privateNetwork.cancelPairing', input: z.object({ ticketId: productIdSchema.optional() }).strict(), response: result },
  devices: { method: 'privateNetwork.devices', input: empty, response: z.array(deviceStateSchema).max(256) },
  revoke: { method: 'privateNetwork.revoke', input: z.object({ deviceId: productIdSchema }).strict(), response: result },
  resetIdentity: { method: 'privateNetwork.resetIdentity', input: empty, response: privateNetworkStatusSchema },
} as const

export type PrivateNetworkManagementApi = {
  [K in keyof typeof privateNetworkManagement]: (input: z.input<(typeof privateNetworkManagement)[K]['input']>) => Promise<z.output<(typeof privateNetworkManagement)[K]['response']>>
}
export type PrivateNetworkStatus = z.infer<typeof privateNetworkStatusSchema>
export type PairedDevice = z.infer<typeof deviceStateSchema>
export type PairingCode = z.infer<typeof pairingQrSchema>
