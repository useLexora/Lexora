import { z } from 'zod'
import { runtimePreferencesSchema } from '../runtime/runtimePreferences'

export const LOCAL_SERVICE_PROTOCOL = 1
export const SERVICE_FRAME_BYTES = 1024 * 1024
export const SERVICE_CONNECTION_BYTES = 4 * SERVICE_FRAME_BYTES
const bounded = z.string().min(1).max(8192)
const identity = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const serviceProcessIdentitySchema = z.object({ pid: z.number().int().positive(), executable: bounded, startIdentity: identity }).strict()
export const serviceIdentitySchema = z.object({
  protocol: z.literal(LOCAL_SERVICE_PROTOCOL),
  profileId: identity,
  serviceInstanceId: z.uuid(),
  buildId: digest,
  sessionId: identity,
  userId: identity,
}).strict()
export const serviceLaunchSchema = z.object({
  version: z.literal(1),
  profile: z.enum(['stable', 'development', 'test']),
  profileRoot: bounded,
  defaultRoot: bounded.optional(),
  resourcesRoot: bounded,
  nodeExecutable: bounded,
  coreEntry: bounded,
  hostExecutable: bounded,
  hostArguments: z.array(z.string().max(8192)).max(8).default([]),
  releaseSetPath: bounded,
  buildId: digest,
  sessionId: identity,
  userId: identity,
  leaseDirectory: bounded.optional(),
  privateDirectoriesExecutable: bounded.optional(),
  storageAuthority: z.enum(['legacy_jsonl', 'sqlite']),
}).strict()
export const serviceDiscoverySchema = serviceIdentitySchema.extend({
  process: serviceProcessIdentitySchema,
  managementEndpoint: bounded,
  productEndpoint: bounded,
  phase: z.enum(['starting', 'recovering', 'maintenance', 'ready', 'stopping', 'failed']),
}).strict()
export const serviceHelloSchema = serviceIdentitySchema.extend({
  type: z.literal('hello'),
  role: z.enum(['host', 'management', 'product']),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const serviceWelcomeSchema = serviceIdentitySchema.extend({ type: z.literal('welcome'), connectionId: z.uuid() }).strict()
export const serviceHostBootstrapSchema = z.object({
  version: z.literal(1),
  identity: serviceIdentitySchema,
  profile: z.enum(['stable', 'development', 'test']),
  profileRoot: bounded,
  resourcesRoot: bounded,
  endpoint: bounded,
  managementEndpoint: bounded,
  managementSecret: digest,
  hostInstanceId: z.uuid(),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const desktopOpenIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tasks'), conversationId: identity.optional() }).strict(),
  z.object({ kind: z.literal('settings') }).strict(),
])
export const desktopOpenResultSchema = z.object({
  accepted: z.boolean(),
  uiReady: z.boolean(),
  targetVisible: z.boolean(),
  visible: z.boolean(),
  focused: z.boolean(),
}).strict()
export type DesktopOpenIntent = z.infer<typeof desktopOpenIntentSchema>
export type DesktopOpenResult = z.infer<typeof desktopOpenResultSchema>

export const serviceStopReasonSchema = z.enum(['user', 'explicit', 'restart', 'maintenance', 'session_end'])
export const serviceManagementRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.uuid(), method: z.literal('status') }).strict(),
  z.object({ id: z.uuid(), method: z.literal('openDesktop'), expectedServiceInstanceId: z.uuid(), intent: desktopOpenIntentSchema }).strict(),
  z.object({ id: z.uuid(), method: z.literal('stop'), expectedServiceInstanceId: z.uuid(), reason: serviceStopReasonSchema }).strict(),
])
export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>
export type ServiceLaunch = z.infer<typeof serviceLaunchSchema>
export type ServiceDiscovery = z.infer<typeof serviceDiscoverySchema>
export type ServiceHello = z.infer<typeof serviceHelloSchema>
export type ServiceHostBootstrap = z.infer<typeof serviceHostBootstrapSchema>
export type ServiceManagementRequest = z.infer<typeof serviceManagementRequestSchema>

export const platformHostReadySchema = z.object({
  hostInstanceId: z.uuid(),
  proxy: z.object({ httpProxy: z.string(), httpsProxy: z.string(), noProxy: z.string() }).strict(),
  preferences: runtimePreferencesSchema,
  display: z.boolean(),
}).strict()
export const serviceRuntimeStateSchema = z.object({
  generation: z.uuid(),
  status: z.enum(['stopped', 'starting', 'ready', 'restarting', 'offline', 'stopping']),
  maintenance: z.literal('backup').nullable(),
  errorCode: z.string().min(1).max(128).nullable(),
}).strict()
export const serviceMaintenanceTicketSchema = z.object({ token: z.uuid(), generation: z.uuid() }).strict()
export const desktopTargetRequestSchema = z.object({ requestId: z.uuid(), intent: desktopOpenIntentSchema }).strict()
export const desktopTargetAckSchema = z.object({ requestId: z.uuid(), opened: z.boolean() }).strict()
