import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import type { ExecutionComposerInputService } from './ExecutionComposerInputService'
import type { ExecutionPresentationService } from './ExecutionPresentationService'
import { executionPresentationRpc } from '../../../../shared/executions/executionPresentationApi'
import { registerRuntimeRequest } from '../../rpc/runtimeRequest'

export function registerExecutionRpc(options: { rpc: RuntimeRequestRegistrar, service: ExecutionPresentationService, inputs: ExecutionComposerInputService }): () => void {
  const stops = [
    registerRuntimeRequest(options.rpc, executionPresentationRpc.list, input => options.service.list(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.detail, input => options.service.detail(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.events, input => options.service.events(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.send, input => options.service.send(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.sendDraft, input => options.inputs.send(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.cancelChildren, input => options.service.cancelChildren(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.answer, input => options.service.answer(input)),
    registerRuntimeRequest(options.rpc, executionPresentationRpc.cancel, input => options.service.cancel(input)),
  ]
  return () => stops.forEach(stop => stop())
}
