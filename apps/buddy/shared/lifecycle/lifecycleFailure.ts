import { z } from 'zod'
import { desktopBootstrapFailureSchema } from '../diagnostics/desktopStartupDiagnostic'
import { networkStartupFailureSchema } from '../diagnostics/networkStartupFailure'
import { privateDirectoryErrorCodeSchema, privateDirectoryFailureSchema } from '../diagnostics/privateDirectoryFailure'
import { readLocalChatErrorCode } from '../runtime/localChatError'

export const lifecycleFailureSchema = z.object({
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).optional(),
  errorType: z.string().regex(/^[a-z]\w{0,95}$/i).optional(),
  failure: z.union([privateDirectoryFailureSchema, desktopBootstrapFailureSchema, networkStartupFailureSchema]).optional(),
}).strict()

export type LifecycleFailure = z.infer<typeof lifecycleFailureSchema>

export function readLifecycleFailure(error: unknown): LifecycleFailure {
  let errorCode: string | null = readLocalChatErrorCode(error)
  let failure: LifecycleFailure['failure']
  const visited = new Set<object>()
  for (let current = error; current && typeof current === 'object' && visited.size < 8 && !visited.has(current); current = 'cause' in current ? current.cause : undefined) {
    visited.add(current)
    const code = 'code' in current ? current.code : undefined
    const privateDirectoryCode = privateDirectoryErrorCodeSchema.safeParse(code)
    if (!errorCode) {
      if (privateDirectoryCode.success)
        errorCode = privateDirectoryCode.data
      else if (typeof code === 'string' && ['DESKTOP_BOOTSTRAP_FAILED', 'NETWORK_START_FAILED', 'INITIAL_STATE_UNAVAILABLE', 'POWERSHELL_UNAVAILABLE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ERR_SQLITE_ERROR'].includes(code))
        errorCode = code
    }
    if (!failure && (privateDirectoryCode.success || code === 'DESKTOP_BOOTSTRAP_FAILED' || code === 'NETWORK_START_FAILED')) {
      const schema = privateDirectoryCode.success ? privateDirectoryFailureSchema : code === 'NETWORK_START_FAILED' ? networkStartupFailureSchema : desktopBootstrapFailureSchema
      const parsed = schema.safeParse('failure' in current ? current.failure : undefined)
      if (parsed.success)
        failure = parsed.data
    }
  }
  const errorType = lifecycleFailureSchema.shape.errorType.safeParse(error instanceof Error ? error.name : 'UnknownError')
  return {
    errorCode: errorCode ?? 'OPERATION_FAILED',
    errorType: errorType.success ? errorType.data : 'UnknownError',
    ...(failure ? { failure } : {}),
  }
}
