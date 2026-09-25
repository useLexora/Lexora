import { z } from 'zod'

export const networkStartupFailureSchema = z.object({
  kind: z.literal('network_startup'),
  operation: z.enum(['configure_upstream', 'listen', 'configure_sessions']),
  systemCode: z.enum(['EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETDOWN', 'ENETUNREACH', 'ENOBUFS', 'ENOMEM', 'EMFILE', 'ENFILE', 'EINVAL', 'UNKNOWN']).optional(),
  errno: z.number().int().min(-0x80000000).max(0x7FFFFFFF).optional(),
}).strict()

export type NetworkStartupFailure = z.infer<typeof networkStartupFailureSchema>

export class NetworkStartupError extends Error {
  readonly code = 'NETWORK_START_FAILED'
  readonly failure: NetworkStartupFailure

  constructor(operation: NetworkStartupFailure['operation'], cause: unknown) {
    super('The application network could not be initialized', { cause })
    this.name = 'NetworkStartupError'
    const details = cause && typeof cause === 'object' ? cause : {}
    const systemCode = networkStartupFailureSchema.shape.systemCode.safeParse('code' in details ? details.code : undefined)
    const errno = networkStartupFailureSchema.shape.errno.safeParse('errno' in details ? details.errno : undefined)
    this.failure = {
      kind: 'network_startup',
      operation,
      ...(systemCode.success && systemCode.data ? { systemCode: systemCode.data } : {}),
      ...(errno.success && errno.data !== undefined ? { errno: errno.data } : {}),
    }
  }
}
