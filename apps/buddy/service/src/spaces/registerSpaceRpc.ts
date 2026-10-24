import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { SpaceRecord } from '../storage/spaceRepository'
import type { SpaceService } from './SpaceService'
import type { SpaceWorkspaceDirectories } from './SpaceWorkspaceDirectories'
import { spacesRpc } from '../../../shared/spaces/spaceApi'
import { ok, registerRuntimeRequest } from '../rpc/runtimeRequest'

export interface RegisterSpaceRpcOptions {
  rpc: RuntimeRequestRegistrar
  service: SpaceService
  workspaces?: SpaceWorkspaceDirectories
}

export function registerSpaceRpc(options: RegisterSpaceRpcOptions): () => void {
  const disposers: Array<() => void> = []
  const present = (space: SpaceRecord) => options.workspaces
    ? { ...space, workspaceDirectory: options.workspaces.get(space) }
    : space

  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.create, async (params) => {
    return present(await options.service.create(params))
  }))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.update, async input => present(await options.service.update(input))))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.delete, async (input) => {
    await options.service.delete(input.spaceId)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.list, (input) => {
    return options.service.list().slice(0, input.limit ?? 100).map(present)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, spacesRpc.searchFiles, (input) => {
    return options.service.searchFiles(input.spaceId, input.query, input.deepSearch ?? false)
  }))

  return () => disposers.splice(0).forEach(dispose => dispose())
}
