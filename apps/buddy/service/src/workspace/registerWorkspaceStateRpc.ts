import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { WorkspaceStateService } from './WorkspaceStateService'
import { workspaceStateRpc } from '../../../shared/conversation/workspaceApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerWorkspaceStateRpc(options: { service: Pick<WorkspaceStateService, 'read' | 'write'>, rpc: RuntimeRequestRegistrar }): () => void {
  const disposers = [
    registerRuntimeRequest(options.rpc, workspaceStateRpc.read, () => options.service.read()),
    registerRuntimeRequest(options.rpc, workspaceStateRpc.write, input => options.service.write(input.value)),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
