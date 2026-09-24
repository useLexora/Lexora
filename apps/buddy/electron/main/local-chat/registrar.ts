import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ApplicationDiagnostic, ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRequestContract, RuntimeRequestInput, RuntimeRequestResult } from '../../../shared/runtime/apiContract'
import type { LocalChatErrorCode } from '../../../shared/runtime/localChatError'
import type { LexoraConfig } from '../../shared/desktopApi'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { ZodError } from 'zod'
import { diagnosticIdentitySchema, safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { isRoutineRpc } from '../../../shared/diagnostics/rpcDiagnosticPolicy'
import { formatLocalChatPublicError, readLocalChatErrorCode } from '../../../shared/runtime/localChatError'
import { assertTrustedSender } from '../ipc'

export interface DesktopRuntimeGateway {
  readonly state: unknown
  onNotification: (
    listener: (notification: { method: string, params: unknown }) => void,
  ) => () => void
  onStateChange: (listener: (state: unknown) => void) => () => void
  request: (
    method: string,
    params: unknown,
    options?: { timeoutMs?: number, requestId?: string },
  ) => Promise<unknown>
  restart: () => Promise<void>
}

export interface RegisterLocalChatIpcOptions {
  recordDiagnostic?: ApplicationDiagnosticReporter
  getLanguage: () => LexoraConfig['desktop']['language']
  getWindow: () => BrowserWindow | null
  openModelSnapshotDirectory: () => Promise<void>
  readWebCredential: () => Promise<unknown>
  runtime: DesktopRuntimeGateway
}

export function createLocalChatIpcContext(options: RegisterLocalChatIpcOptions) {
  const record = safeDiagnosticReporter(options.recordDiagnostic)
  const registeredChannels: string[] = []
  const handle = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: T) => unknown,
  ) => {
    registeredChannels.push(channel)
    ipcMain.handle(channel, async (event, input: T) => {
      try {
        assertTrustedSender(event, options.getWindow())
        return await handler(event, input)
      }
      catch (error) {
        throw createLocalChatIpcError(error)
      }
    })
  }
  const request = async <Contract extends RuntimeRequestContract>(contract: Contract, params: RuntimeRequestInput<Contract>, timeoutMs = 30_000): Promise<RuntimeRequestResult<Contract>> => {
    const context = { method: contract.method, operationId: randomUUID(), ...requestIdentity(params) }
    const startedAt = performance.now()
    if (!isRoutineRpc(contract.method))
      record({ ...context, event: 'rpc.request.started', level: 'info' })
    try {
      const result = contract.response.safeParse(await options.runtime.request(contract.method, params, { timeoutMs, requestId: context.operationId }))
      if (!result.success)
        throw new DesktopRuntimeResponseError()
      const durationMs = Math.round(performance.now() - startedAt)
      if (!isRoutineRpc(contract.method) || durationMs >= 1000)
        record({ ...context, ...requestIdentity(result.data), event: 'rpc.request.completed', level: isRoutineRpc(contract.method) && durationMs >= 1000 ? 'warn' : 'info', durationMs, ...(Array.isArray(result.data) ? { count: result.data.length } : {}) })
      return result.data as RuntimeRequestResult<Contract>
    }
    catch (error) {
      record({ ...context, event: 'rpc.request.failed', level: 'error', durationMs: Math.round(performance.now() - startedAt), errorCode: readLocalChatErrorCode(error) ?? 'LOCAL_CHAT_OPERATION_FAILED' })
      throw error
    }
  }
  return { handle, request, options, dispose: () => {
    for (const channel of registeredChannels)
      ipcMain.removeHandler(channel)
  } }
}

function requestIdentity(value: unknown): Pick<ApplicationDiagnostic, 'conversationId' | 'branchId' | 'runId' | 'requestId'> {
  const identity: ReturnType<typeof requestIdentity> = {}
  if (!isRecord(value))
    return identity
  for (const key of ['conversationId', 'branchId', 'runId', 'requestId'] as const) {
    const parsed = diagnosticIdentitySchema.safeParse(value[key])
    if (parsed.success)
      identity[key] = parsed.data
  }
  return identity
}

export type LocalChatIpcContext = ReturnType<typeof createLocalChatIpcContext>

class DesktopRuntimeResponseError extends Error {
  readonly code = 'RUNTIME_PROTOCOL_ERROR'
}

function createLocalChatIpcError(error: unknown): Error {
  if (error instanceof ZodError) {
    return publicError('VALIDATION_FAILED', false)
  }
  const code = readLocalChatErrorCode(error)
  if (code) {
    return publicError(code, new Set<LocalChatErrorCode>([
      'AUTHENTICATION_REQUIRED',
      'CONNECTOR_UNAVAILABLE',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_HAS_ACTIVE_RUNS',
      'RUNTIME_UNAVAILABLE',
    ]).has(code))
  }
  return publicError('LOCAL_CHAT_OPERATION_FAILED', false)
}

function publicError(code: LocalChatErrorCode, retryable: boolean): Error {
  return new Error(formatLocalChatPublicError({ code, retryable }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
