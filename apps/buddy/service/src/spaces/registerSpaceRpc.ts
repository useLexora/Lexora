import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { SpaceService } from './SpaceService'
import { spacesRpc } from '../../../shared/spaces/spaceApi'
import { ok, registerRuntimeRequest } from '../rpc/runtimeRequest'

export interface RegisterSpaceRpcOptions {
  rpc: RuntimeRequestRegistrar
  service: SpaceService
}

export function registerSpaceRpc(options: RegisterSpaceRpcOptions): () => void {
  const disposers: Array<() => void> = []

  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.create, (params) => {
    return options.service.create(params)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.update, input => options.service.update(input)))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.delete, async (input) => {
    await options.service.delete(input.spaceId)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.list, (input) => {
    return options.service.list().slice(0, input.limit ?? 100)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.searchFiles, (input) => {
    return options.service.searchFiles(input.spaceId, input.query, input.deepSearch ?? false)
  }))

  return () => disposers.splice(0).forEach(dispose => dispose())
}
