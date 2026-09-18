import type { z } from 'zod'
import type { RuntimeRequestContract } from '../../../shared/runtime/apiContract'
import type { RuntimeRequestHandler } from '../../../shared/runtime/rpcPeer'

export interface RuntimeRequestRegistrar {
  onRequest: (method: string, handler: RuntimeRequestHandler) => () => void
}

export interface RuntimeRpcRegistrar extends RuntimeRequestRegistrar {
  onNotification: (listener: (method: string, params: unknown) => void) => () => void
}

export function registerRuntimeRequest<Contract extends RuntimeRequestContract, Result>(
  rpc: RuntimeRequestRegistrar,
  contract: Contract,
  handler: (input: z.output<Contract['input']>, signal?: AbortSignal) => Result,
): () => void {
  return rpc.onRequest(contract.method, (params, signal) => handler(parse(contract.input, params) as z.output<Contract['input']>, signal))
}

export type BuddyServiceErrorCode
  = | 'DRAFT_CONFLICT'
    | 'DIRECTORY_NOT_AUTHORIZED'
    | 'MODEL_INPUT_UNSUPPORTED'
    | 'MODEL_INPUT_TOO_LARGE'
    | 'SPACE_UNAVAILABLE'
    | 'VALIDATION_FAILED'

export class BuddyServiceError extends Error {
  readonly code: BuddyServiceErrorCode

  constructor(code: BuddyServiceErrorCode) {
    super('Lexora Buddy runtime request failed')
    this.name = 'BuddyServiceError'
    this.code = code
  }
}

export function ok() {
  return { ok: true as const }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new BuddyServiceError('VALIDATION_FAILED')
  return result.data
}
