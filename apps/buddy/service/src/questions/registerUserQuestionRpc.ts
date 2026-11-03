import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { UserQuestionService } from './UserQuestionService'
import { userQuestionRpc } from '../../../shared/questions/userQuestionApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerUserQuestionRpc({ rpc, service }: { rpc: RuntimeRequestRegistrar, service: UserQuestionService }) {
  const stops = [
    registerRuntimeRequest(rpc, userQuestionRpc.list, input => service.list(input)),
    registerRuntimeRequest(rpc, userQuestionRpc.answer, input => service.answer(input)),
    registerRuntimeRequest(rpc, userQuestionRpc.retry, input => service.retry(input)),
    registerRuntimeRequest(rpc, userQuestionRpc.cancel, input => service.cancel(input)),
  ]
  return () => stops.forEach(stop => stop())
}
