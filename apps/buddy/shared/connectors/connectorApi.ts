import type { RuntimeRequestContract } from '../runtime/apiContract'

import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { isHttpEndpointUrl } from '../network/networkSecurity'
import { idSchema, isAbsolutePath, validationRequestSchemas, validationResponseSchemas } from '../runtime/apiValidation'
import { editableConnectorCredentialSchema } from './connectorCredentials'
import { connectorRuntimeStateSchema, connectorToolSummarySchema } from './connectorState'

export const connectorBaseSchema = z.object({
  credentialConfigured: z.boolean(),
  enabled: z.boolean(),
  executionConfirmed: z.boolean(),
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(128),
  runtime: connectorRuntimeStateSchema,
})

export const connectorSchema = z.discriminatedUnion('transport', [
  connectorBaseSchema.extend({
    args: z.array(z.string()),
    command: z.string().min(1),
    cwd: z.string().nullable(),
    transport: z.literal('stdio'),
  }).strict(),
  connectorBaseSchema.extend({
    transport: z.literal('streamable-http'),
    url: z.url().refine(isHttpEndpointUrl),
  }).strict(),
])

export const connectorConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    args: z.array(z.string().max(4096)).max(128),
    command: z.string().trim().min(1).max(4096),
    cwd: z.string().trim().refine(isAbsolutePath).nullable(),
    enabled: z.boolean(),
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(128),
    transport: z.literal('stdio'),
  }).strict(),
  z.object({
    enabled: z.boolean(),
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(128),
    transport: z.literal('streamable-http'),
    url: z.url().refine(isHttpEndpointUrl),
  }).strict(),
])

export const connectorCredentialSchema = editableConnectorCredentialSchema

export const connectorCredentialMutationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }).strict(),
  z.object({ mode: z.literal('clear') }).strict(),
  z.object({ mode: z.literal('replace'), value: connectorCredentialSchema }).strict(),
])

export type LocalConnector = DeepReadonly<z.infer<typeof connectorSchema>>

export type LocalConnectorConfig = z.infer<typeof connectorConfigSchema>

export type LocalConnectorCredential = z.infer<typeof connectorCredentialSchema>

export type LocalConnectorCredentialMutation = z.infer<typeof connectorCredentialMutationSchema>

export const connectorsRequestSchemas = {
  connectorCredential: z.object({
    connectorId: idSchema,
    credential: connectorCredentialSchema,
  }).strict(),
  connectorId: z.object({ connectorId: idSchema }).strict(),
  connectorEnabled: z.object({ connectorId: idSchema, enabled: z.boolean() }).strict(),
  connectorExecutionConfirmation: z.object({ connectorId: idSchema }).strict(),
  connectorUpsert: z.object({
    config: connectorConfigSchema,
    credential: connectorCredentialMutationSchema,
  }).strict(),
} as const

export const connectorsResponseSchemas = {
  connectors: z.array(connectorSchema),
  tools: z.array(connectorToolSummarySchema),
} as const

export const connectorsRpc = {
  list: { method: 'connectors.list', input: validationRequestSchemas.empty, response: connectorsResponseSchemas.connectors },
  upsert: { method: 'connectors.upsert', input: connectorsRequestSchemas.connectorUpsert, response: connectorsResponseSchemas.connectors },
  setEnabled: { method: 'connectors.setEnabled', input: connectorsRequestSchemas.connectorEnabled, response: validationResponseSchemas.mutation },
  test: { method: 'connectors.test', input: connectorsRequestSchemas.connectorId, response: connectorRuntimeStateSchema },
  tools: { method: 'connectors.tools', input: connectorsRequestSchemas.connectorId, response: connectorsResponseSchemas.tools },
  login: { method: 'connectors.login', input: connectorsRequestSchemas.connectorId, response: validationResponseSchemas.mutation },
  cancelLogin: { method: 'connectors.cancelLogin', input: connectorsRequestSchemas.connectorId, response: validationResponseSchemas.mutation },
  remove: { method: 'connectors.remove', input: connectorsRequestSchemas.connectorId, response: validationResponseSchemas.mutation },
  confirmExecution: { method: 'connectors.confirmExecution', input: connectorsRequestSchemas.connectorExecutionConfirmation, response: validationResponseSchemas.mutation },
  saveCredential: { method: 'connectors.saveCredential', input: connectorsRequestSchemas.connectorCredential, response: validationResponseSchemas.mutation },
  clearCredential: { method: 'connectors.clearCredential', input: connectorsRequestSchemas.connectorId, response: validationResponseSchemas.mutation },
} as const satisfies Record<string, RuntimeRequestContract>
