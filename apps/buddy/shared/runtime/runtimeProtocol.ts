import { z } from 'zod'

export const BUDDY_SERVICE_PROTOCOL_VERSION = 16 as const

export const BUDDY_SERVICE_FAILURE_CODES = [
  'EVENT_LOG_CORRUPTED',
  'EVENT_PROJECTION_FAILED',
  'EVENT_STORAGE_FAILED',
  'RUNTIME_START_FAILED',
] as const

export const BUDDY_SERVICE_SUPERVISOR_FAILURE_CODES = [
  ...BUDDY_SERVICE_FAILURE_CODES,
  'RUNTIME_PROTOCOL_FAILED',
  'RUNTIME_PROTOCOL_INCOMPATIBLE',
  'RUNTIME_READINESS_TIMEOUT',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_STOPPED',
  'RUNTIME_TERMINATION_FAILED',
] as const

export const buddyServiceFailureCodeSchema = z.enum(BUDDY_SERVICE_FAILURE_CODES)
export const buddyServiceSupervisorFailureCodeSchema = z.enum(BUDDY_SERVICE_SUPERVISOR_FAILURE_CODES)

export const buddyServiceFailureNotificationSchema = z.object({
  code: buddyServiceFailureCodeSchema,
}).strict()

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
}).strict()

export const rpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string().min(1),
  result: z.unknown(),
}).strict()

export const rpcFailureSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string().min(1),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }).strict(),
}).strict()

export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown(),
}).strict()

export const runtimeWireMessageSchema = z.union([
  rpcRequestSchema,
  rpcSuccessSchema,
  rpcFailureSchema,
  rpcNotificationSchema,
])

export type RpcRequest = z.infer<typeof rpcRequestSchema>
export type RpcSuccess = z.infer<typeof rpcSuccessSchema>
export type RpcFailure = z.infer<typeof rpcFailureSchema>
export type RpcNotification = z.infer<typeof rpcNotificationSchema>
export type RuntimeWireMessage = z.infer<typeof runtimeWireMessageSchema>
export type BuddyServiceFailureCode = z.infer<typeof buddyServiceFailureCodeSchema>
export type BuddyServiceSupervisorFailureCode = z.infer<typeof buddyServiceSupervisorFailureCodeSchema>
