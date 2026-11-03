import type { LocalChatIpcContext } from './registrar'
import { userQuestionRpc } from '../../../shared/questions/userQuestionApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerQuestionsIpc({ handle, request }: LocalChatIpcContext): void {
  handle(LOCAL_CHAT_IPC_CHANNELS.questionsList, (_event, input) => request(userQuestionRpc.list, userQuestionRpc.list.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.questionsAnswer, (_event, input) => request(userQuestionRpc.answer, userQuestionRpc.answer.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.questionsRetry, (_event, input) => request(userQuestionRpc.retry, userQuestionRpc.retry.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.questionsCancel, (_event, input) => request(userQuestionRpc.cancel, userQuestionRpc.cancel.input.parse(input)))
}
