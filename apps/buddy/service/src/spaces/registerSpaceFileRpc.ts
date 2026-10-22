import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { SpaceFileService } from './SpaceFileService'
import { spaceFilesRpc } from '../../../shared/spaces/spaceFileApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerSpaceFileRpc(rpc: RuntimeRequestRegistrar, files: SpaceFileService): () => void {
  const disposers = [
    registerRuntimeRequest(rpc, spaceFilesRpc.resolveMedia, input => files.resolveMedia(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.mutate, input => files.mutate(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.history, input => files.history(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.query, input => files.query(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.acknowledge, input => files.acknowledge(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.cancel, input => files.cancel(input)),

    registerRuntimeRequest(rpc, spaceFilesRpc.readDocument, input => files.readDocument(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.saveDocument, input => files.saveDocument(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.list, input => files.list(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.read, input => files.read(input)),
    registerRuntimeRequest(rpc, spaceFilesRpc.locate, input => files.locate(input)),
  ]
  return () => disposers.forEach(dispose => dispose())
}
