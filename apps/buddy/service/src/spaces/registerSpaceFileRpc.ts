import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { SpaceRepository } from '../storage/spaceRepository'
import { spaceFilesRpc } from '../../../shared/spaces/spaceFileApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'
import { SpaceFileService } from './SpaceFileService'

export function registerSpaceFileRpc(rpc: RuntimeRequestRegistrar, spaces: Pick<SpaceRepository, 'findById'>): () => void {
  const files = new SpaceFileService(spaces)
  const disposers = [
    registerRuntimeRequest(rpc, spaceFilesRpc.readDocument, input => files.readDocument(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.saveDocument, input => files.saveDocument(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.list, input => files.list(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.read, input => files.read(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.locate, input => files.locate(input)),
  ]
  return () => disposers.forEach(dispose => dispose())
}
