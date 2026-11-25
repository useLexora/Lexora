import type { ApplicationDiagnosticReporter } from './applicationDiagnostic'
import { z } from 'zod'
import { safeDiagnosticReporter } from './applicationDiagnostic'

type Stage = 'host.received' | 'host.validate' | 'host.dispatch' | 'preflight' | 'admission' | 'admitted' | 'resources' | 'worker.start' | 'worker.wait' | 'worker.ready' | 'worker.capacity' | 'invoke.awaiting_event' | 'invoke.first_event' | 'invoke.stream' | 'cleanup'

const requestIdSchema = z.uuid()
const systemCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EIO', 'EPIPE', 'ENOEXEC', 'EMFILE', 'ENFILE', 'ENOSPC', 'EDQUOT', 'ENOMEM', 'EAGAIN'])
const publicCodes = new Set([
  'EXTENSION_INFERENCE_BACKEND_FAILED',
  'EXTENSION_INFERENCE_CANCELLED',
  'EXTENSION_INFERENCE_CONFIGURATION_CHANGED',
  'EXTENSION_INFERENCE_CONTEXT_TOO_LARGE',
  'EXTENSION_INFERENCE_CREDENTIAL_UNAVAILABLE',
  'EXTENSION_INFERENCE_GPU_DENIED',
  'EXTENSION_INFERENCE_GPU_UNAVAILABLE',
  'EXTENSION_INFERENCE_INPUT_UNSUPPORTED',
  'EXTENSION_INFERENCE_LOAD_FAILED',
  'EXTENSION_INFERENCE_LOAD_TIMEOUT',
  'EXTENSION_INFERENCE_OUTPUT_INVALID',
  'EXTENSION_INFERENCE_PLATFORM_UNSUPPORTED',
  'EXTENSION_INFERENCE_PROCESS_EXITED',
  'EXTENSION_INFERENCE_PROCESS_UNAVAILABLE',
  'EXTENSION_INFERENCE_RESOURCE_CHANGED',
  'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED',
  'EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE',
  'EXTENSION_INFERENCE_SANDBOX_UNAVAILABLE',
  'EXTENSION_INFERENCE_SETUP_REQUIRED',
  'EXTENSION_INFERENCE_STOPPING',
  'EXTENSION_INFERENCE_STORAGE_FULL',
  'EXTENSION_INFERENCE_STORAGE_NO_SPACE',
  'EXTENSION_INFERENCE_STORAGE_QUOTA_EXCEEDED',
  'EXTENSION_INFERENCE_TOOL_INVALID',
  'EXTENSION_INFERENCE_UNAVAILABLE',
])

function failureCode(error: unknown): string {
  if (error instanceof Error && publicCodes.has(error.message))
    return error.message
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && systemCodes.has(error.code))
    return error.code
  return 'EXTENSION_INFERENCE_BACKEND_FAILED'
}

export class InferenceInvocationDiagnostic {
  readonly #record: ApplicationDiagnosticReporter
  readonly #requestId?: string
  readonly #extensionId?: string
  stage: Stage = 'preflight'
  operationId?: string

  constructor(report: ApplicationDiagnosticReporter | undefined, id: unknown, extensionId?: string) {
    this.#record = safeDiagnosticReporter(report)
    this.#requestId = requestIdSchema.safeParse(id).data
    this.#extensionId = extensionId
  }

  mark(stage: Stage): void {
    this.stage = stage
    this.#record({ component: 'models.inference', event: `inference.${stage}`, level: 'info', requestId: this.#requestId, operationId: this.operationId, extensionId: this.#extensionId })
  }

  failed(error: unknown, storageCode?: 'EXTENSION_INFERENCE_STORAGE_NO_SPACE' | 'EXTENSION_INFERENCE_STORAGE_QUOTA_EXCEEDED' | 'EXTENSION_INFERENCE_LAUNCH_NO_SPACE' | 'EXTENSION_INFERENCE_LAUNCH_QUOTA_EXCEEDED'): void {
    this.#record({ component: 'models.inference', event: `inference.${this.stage}.failed`, level: 'error', requestId: this.#requestId, operationId: this.operationId, extensionId: this.#extensionId, errorCode: storageCode ?? failureCode(error) })
  }
}
