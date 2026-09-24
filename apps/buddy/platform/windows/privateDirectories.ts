import type { PrivateDirectoryFailure } from '../../shared/diagnostics/privateDirectoryFailure'
import type { NativeCommandResult } from '../native/nativeCommand'
import process from 'node:process'
import { z } from 'zod'
import { privateDirectoryErrorCodeSchema, privateDirectoryFailureSchema } from '../../shared/diagnostics/privateDirectoryFailure'
import { runNativeCommand, runNativeCommandSync } from '../native/nativeCommand'
import { validateWindowsFilePath } from './filePath'

const nativeFailureSchema = z.object({
  code: privateDirectoryErrorCodeSchema.exclude(['PRIVATE_DIRECTORIES_PROCESS_FAILED', 'PRIVATE_DIRECTORIES_INVALID_RESPONSE']),
  ...privateDirectoryFailureSchema.omit({ kind: true, directoryRole: true, exitCode: true, processErrorCode: true }).shape,
  operation: privateDirectoryFailureSchema.shape.operation.exclude(['process']),
}).strict()

export class PrivateDirectoryError extends Error {
  readonly code: z.infer<typeof privateDirectoryErrorCodeSchema>
  readonly failure: PrivateDirectoryFailure

  constructor(
    code: z.infer<typeof privateDirectoryErrorCodeSchema>,
    failure: PrivateDirectoryFailure,
    options?: ErrorOptions,
  ) {
    super('Buddy private storage must prevent other users from reading or changing application data', options)
    this.name = 'PrivateDirectoryError'
    this.code = code
    this.failure = failure
  }
}

export async function ensureWindowsPrivateDirectories(paths: string[], executable?: string): Promise<void> {
  if (!executable)
    throw new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNAVAILABLE', { kind: 'private_directories', operation: 'process' })
  let result
  try {
    result = await runNativeCommand(validateWindowsFilePath(executable), [], { paths: paths.map(validateWindowsFilePath) }, {
      env: { SystemRoot: process.env.SystemRoot },
      maxBytes: 1024,
    })
  }
  catch (cause) {
    throw processFailure(cause)
  }
  validateResult(result)
}

export function ensureWindowsPrivateDirectoriesSync(paths: string[], executable?: string): void {
  if (!executable)
    throw new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNAVAILABLE', { kind: 'private_directories', operation: 'process' })
  let result
  try {
    result = runNativeCommandSync(validateWindowsFilePath(executable), [], { paths: paths.map(validateWindowsFilePath) }, {
      env: { SystemRoot: process.env.SystemRoot },
      maxBytes: 1024,
    })
  }
  catch (cause) {
    throw processFailure(cause)
  }
  validateResult(result)
}

function processFailure(cause: unknown): PrivateDirectoryError {
  const processErrorCode = privateDirectoryFailureSchema.shape.processErrorCode.safeParse(cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined)
  const exitCode = privateDirectoryFailureSchema.shape.exitCode.safeParse(cause && typeof cause === 'object' && 'exitCode' in cause ? cause.exitCode : undefined)
  return new PrivateDirectoryError(processErrorCode.success && processErrorCode.data === 'ENOENT' ? 'PRIVATE_DIRECTORIES_UNAVAILABLE' : 'PRIVATE_DIRECTORIES_PROCESS_FAILED', {
    kind: 'private_directories',
    operation: 'process',
    ...(processErrorCode.success ? { processErrorCode: processErrorCode.data } : {}),
    ...(exitCode.success ? { exitCode: exitCode.data } : {}),
  }, { cause })
}

function validateResult(result: NativeCommandResult): void {
  if (result.code === 0) {
    if (result.stdout.toString('utf8') === '{"ok":true}')
      return
    throw new PrivateDirectoryError('PRIVATE_DIRECTORIES_INVALID_RESPONSE', { kind: 'private_directories', operation: 'response', exitCode: result.code })
  }
  let failure
  try {
    failure = nativeFailureSchema.safeParse(JSON.parse(result.stderr))
  }
  catch {}
  if (failure?.success) {
    const { code, ...details } = failure.data
    throw new PrivateDirectoryError(code, { kind: 'private_directories', ...details, exitCode: result.code })
  }
  throw new PrivateDirectoryError('PRIVATE_DIRECTORIES_PROCESS_FAILED', { kind: 'private_directories', operation: 'process', exitCode: result.code })
}
