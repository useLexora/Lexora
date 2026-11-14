import { z } from 'zod'

export const credentialNamespaceSchema = z.enum(['providers', 'connectors', 'web', 'private-network'])
export const credentialTypeSchema = z.enum(['api_key', 'oauth'])

export const credentialHostErrorCodeSchema = z.enum([
  'CREDENTIAL_STORE_UNAVAILABLE',
  'CREDENTIAL_STORE_FAILURE',
  'VALIDATION_FAILED',
])

const credentialHostFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: credentialHostErrorCodeSchema,
  }).strict(),
}).strict()

export const credentialReadParamsSchema = z.object({
  namespace: credentialNamespaceSchema,
  id: z.string().trim().min(1).max(256),
}).strict()

export const providerCredentialParamsSchema = z.object({
  providerId: z.string().trim().min(1).max(256),
}).strict()

export const credentialWriteParamsSchema = credentialReadParamsSchema.extend({
  value: z.unknown(),
}).strict()

export const providerCredentialWriteParamsSchema = providerCredentialParamsSchema.extend({
  credential: z.unknown(),
}).strict()

export const credentialMutationResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  credentialHostFailureSchema,
])

export const credentialReadResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.unknown().nullable(),
  }).strict(),
  credentialHostFailureSchema,
])

export const credentialProviderListResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    providers: z.array(z.object({
      providerId: z.string().min(1),
      type: credentialTypeSchema,
    }).strict()),
  }).strict(),
  credentialHostFailureSchema,
])

export const openExternalParamsSchema = z.object({
  url: z.url(),
}).strict()

export const openExternalResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.literal('EXTERNAL_URL_NOT_ALLOWED') }).strict(),
  }).strict(),
])

export type CredentialNamespace = z.infer<typeof credentialNamespaceSchema>
export type CredentialHostErrorCode = z.infer<typeof credentialHostErrorCodeSchema>
