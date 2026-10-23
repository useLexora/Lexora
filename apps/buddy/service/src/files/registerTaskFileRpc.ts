import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { TaskFileService } from './TaskFileService'
import { taskFilesRpc } from '../../../shared/files/taskFileApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerTaskFileRpc(rpc: RuntimeRequestRegistrar, service: TaskFileService): () => void {
  const disposers = [
    registerRuntimeRequest(rpc, taskFilesRpc.resolve, input => service.resolve(input)),
    registerRuntimeRequest(rpc, taskFilesRpc.read, input => service.read(input)),
    registerRuntimeRequest(rpc, taskFilesRpc.locate, input => service.locate(input)),
    registerRuntimeRequest(rpc, taskFilesRpc.resolveMedia, input => service.resolveMedia(input)),
    registerRuntimeRequest(rpc, taskFilesRpc.resolveBrowser, input => service.resolveBrowser(input)),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
