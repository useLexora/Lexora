import type { LocalChatIpcContext } from './registrar'
import { chatRequestSchemas, chatRpc } from '../../../shared/conversation/chatApi'
import { chatQueueRpc } from '../../../shared/conversation/chatQueueApi'
import { contextRequestSchemas, contextRpc } from '../../../shared/conversation/contextApi'
import { conversationRequestSchemas, conversationsRpc } from '../../../shared/conversation/conversationApi'
import { conversationTreeRpc } from '../../../shared/conversation/conversationTree'
import { LOCAL_WORKSPACE_STATE_KEY, workspaceRequestSchemas, workspaceStateRpc } from '../../../shared/conversation/workspaceApi'
import { runsRequestSchemas } from '../../../shared/runs/runApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerConversationIpc(context: LocalChatIpcContext): void {
  const { handle, request } = context
  handle(LOCAL_CHAT_IPC_CHANNELS.chatQueueEnqueue, (_event, input) => request(chatQueueRpc.enqueue, chatQueueRpc.enqueue.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.chatQueueList, (_event, input) => request(chatQueueRpc.list, chatQueueRpc.list.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.chatQueueCancel, (_event, input) => request(chatQueueRpc.cancel, chatQueueRpc.cancel.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.chatQueueSteer, (_event, input) => request(chatQueueRpc.steer, chatQueueRpc.steer.input.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.contextUsageSnapshot, (_event, input) => request(contextRpc.usageSnapshot, contextRequestSchemas.contextUsageSnapshot.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.workspaceStateRead, () => request(workspaceStateRpc.read, { key: LOCAL_WORKSPACE_STATE_KEY }))

  handle(LOCAL_CHAT_IPC_CHANNELS.workspaceStateWrite, (_event, input) => {
    const { value } = workspaceRequestSchemas.workspaceValue.parse(input)
    return request(workspaceStateRpc.write, { key: LOCAL_WORKSPACE_STATE_KEY, value })
  })

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsGetNodeDetail, (_event, input) => request(conversationTreeRpc.detail, conversationTreeRpc.detail.input.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsGetTree, (_event, input) => request(conversationTreeRpc.get, conversationTreeRpc.get.input.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsListReferenceAccess, (_event, input) => request(conversationsRpc.listReferenceAccess, conversationsRpc.listReferenceAccess.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsSetReferenceExcluded, (_event, input) => request(conversationsRpc.setReferenceExcluded, conversationsRpc.setReferenceExcluded.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsList, (_event, input) => request(conversationsRpc.list, conversationRequestSchemas.list.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsGet, (_event, input) => request(conversationsRpc.get, conversationRequestSchemas.conversationId.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsGetModelControls, (_event, input) => request(conversationsRpc.getModelControls, conversationRequestSchemas.modelControls.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsDelete, (_event, input) => request(conversationsRpc.delete, conversationRequestSchemas.conversationId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsActivateBranch, (_event, input) => request(conversationsRpc.activateBranch, conversationRequestSchemas.conversationBranchActivation.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsListBranches, (_event, input) => request(conversationsRpc.listBranches, conversationRequestSchemas.conversationId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsListMessages, (_event, input) => request(conversationsRpc.listMessages, conversationRequestSchemas.conversationMessages.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsRename, (_event, input) => request(conversationsRpc.rename, conversationRequestSchemas.conversationRename.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsSetPermissionSettings, (_event, input) => request(conversationsRpc.setPermissionSettings, conversationRequestSchemas.conversationPermissionSettings.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsListMembers, (_event, input) => request(conversationsRpc.listMembers, conversationsRpc.listMembers.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsAddMember, (_event, input) => request(conversationsRpc.addMember, conversationsRpc.addMember.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsRemoveMember, (_event, input) => request(conversationsRpc.removeMember, conversationsRpc.removeMember.input.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsSetBuddy, (_event, input) => request(conversationsRpc.setBuddy, conversationRequestSchemas.conversationBuddy.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsSetModelSelection, (_event, input) => request(conversationsRpc.setModelSelection, conversationRequestSchemas.conversationModelSelection.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.conversationsListTimeline, (_event, input) => request(conversationsRpc.listTimeline, conversationRequestSchemas.conversationTimeline.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.chatStartTurn, (_event, input) => request(chatRpc.startTurn, chatRequestSchemas.startTurn.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.chatEditUserMessage, (_event, input) => request(chatRpc.editUserMessage, chatRequestSchemas.editUserMessage.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.chatExecuteCommand, (_event, input) => request(chatRpc.executeCommand, chatRequestSchemas.chatCommand.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.chatRegenerateAssistant, (_event, input) => request(chatRpc.regenerateAssistant, chatRequestSchemas.regenerateAssistant.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.chatCancel, (_event, input) => request(chatRpc.cancel, runsRequestSchemas.runId.parse(input)))
}
