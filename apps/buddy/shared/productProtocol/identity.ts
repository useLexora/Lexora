import { z } from 'zod'
import { PRODUCT_LIMITS } from './limits'
import { productIdSchema, productRevisionSchema } from './scalars'

export const PRODUCT_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 })
export const productInitializeSchema = z.object({
  protocol: z.object({ major: z.number().int().nonnegative(), minMinor: z.number().int().nonnegative(), maxMinor: z.number().int().nonnegative() }).strict().refine(value => value.minMinor <= value.maxMinor),
  client: z.object({ kind: z.enum(['desktop', 'mobile']), version: z.string().min(1).max(80) }).strict(),
  supportedContentKinds: z.array(z.string().min(1).max(80)).max(64),
  supportedReviewKinds: z.array(z.string().min(1).max(80)).max(64),
}).strict()
export const productIdentitySchema = z.object({
  serviceId: productIdSchema,
  profileId: productIdSchema,
  dataGeneration: productIdSchema,
  serviceInstanceId: productIdSchema,
  connectionId: productIdSchema,
  clientSessionId: productIdSchema,
  deviceId: productIdSchema,
}).strict()
export type ProductIdentity = z.infer<typeof productIdentitySchema>
export interface TrustedProductContext extends ProductIdentity {
  readonly ownerPrincipalId: string
  readonly credentialId: string
  readonly grantGeneration: string
  readonly role: 'owner' | 'reader'
}
export const productPhaseSchema = z.enum(['starting', 'recovering', 'ready', 'stopping'])
export const productInitializeResultSchema = productIdentitySchema.extend({
  protocol: z.object({ major: z.literal(1), minor: z.literal(0) }).strict(),
  serverTime: z.iso.datetime(),
  phase: productPhaseSchema,
  capabilities: z.array(z.string()),
  limits: z.object(Object.fromEntries(Object.entries(PRODUCT_LIMITS).map(([key, value]) => [key, z.literal(value)])) as { [K in keyof typeof PRODUCT_LIMITS]: z.ZodLiteral<(typeof PRODUCT_LIMITS)[K]> }).strict(),
}).strict()
export const productGrantGenerationSchema = productRevisionSchema

export function classifyProductIdentityChange(previous: ProductIdentity, current: ProductIdentity): 'connection' | 'service' | 'trust' {
  if (previous.profileId !== current.profileId || previous.dataGeneration !== current.dataGeneration || previous.serviceId !== current.serviceId || previous.deviceId !== current.deviceId)
    return 'trust'
  return previous.serviceInstanceId !== current.serviceInstanceId ? 'service' : 'connection'
}
