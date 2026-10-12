import type { LocalChatIpcContext } from './registrar'
import { executionPresentationRpc } from '../../../shared/executions/executionPresentationApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerExecutionsIpc({ handle, request }: LocalChatIpcContext): void {
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsList, (_event, input) => request(executionPresentationRpc.list, executionPresentationRpc.list.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsDetail, (_event, input) => request(executionPresentationRpc.detail, executionPresentationRpc.detail.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsEvents, (_event, input) => request(executionPresentationRpc.events, executionPresentationRpc.events.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsSend, (_event, input) => request(executionPresentationRpc.send, executionPresentationRpc.send.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsCancelChildren, (_event, input) => request(executionPresentationRpc.cancelChildren, executionPresentationRpc.cancelChildren.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsAnswer, (_event, input) => request(executionPresentationRpc.answer, executionPresentationRpc.answer.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.executionsCancel, (_event, input) => request(executionPresentationRpc.cancel, executionPresentationRpc.cancel.input.parse(input)))
}
