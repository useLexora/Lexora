import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { TaskAttentionProjection } from './TaskAttentionProjection'
import type { TaskMarkService } from './TaskMarkService'
import { taskMarksRpc } from '../../../shared/conversation/taskMarkApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerTaskMarkRpc(rpc: RuntimeRequestRegistrar, service: Pick<TaskMarkService, 'create' | 'update' | 'delete' | 'assign' | 'setRead' | 'clear'>, attention: Pick<TaskAttentionProjection, 'list' | 'states'>): () => void {
  const disposers = [
    registerRuntimeRequest(rpc, taskMarksRpc.list, () => attention.list()),
    registerRuntimeRequest(rpc, taskMarksRpc.create, input => service.create(input)),
    registerRuntimeRequest(rpc, taskMarksRpc.update, input => service.update(input.id, input)),
    registerRuntimeRequest(rpc, taskMarksRpc.delete, input => service.delete(input.id)),
    registerRuntimeRequest(rpc, taskMarksRpc.states, input => attention.states(input.conversationIds)),
    registerRuntimeRequest(rpc, taskMarksRpc.assign, input => service.assign(input.conversationId, input.markId)),
    registerRuntimeRequest(rpc, taskMarksRpc.setRead, input => service.setRead(input)),
    registerRuntimeRequest(rpc, taskMarksRpc.clear, input => service.clear(input)),
  ]
  return () => disposers.forEach(dispose => dispose())
}
