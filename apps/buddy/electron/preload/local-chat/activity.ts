import type { ArtifactChangeNotice } from '../../../shared/artifacts/artifactApi'
import type { ChangeSetChangeNotice } from '../../../shared/changes/changeApi'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createActivityApi(): Pick<LocalChatApi, 'artifacts' | 'notifications' | 'changes' | 'runs' | 'approvals' | 'usage'> {
  return {
    artifacts: Object.freeze({
      onChanged: listener => subscribe<ArtifactChangeNotice>(LOCAL_CHAT_IPC_CHANNELS.artifactsChanged, listener),
      readText: artifactId => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.artifactsReadText,
        { artifactId },
      ),
    }),
    notifications: Object.freeze({
      onChanged: listener => subscribe(LOCAL_CHAT_IPC_CHANNELS.notificationsChanged, listener),
      list: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.notificationsList),
      markAllSeen: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.notificationsMarkAllSeen),
      markSeen: (notificationId, revision) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.notificationsMarkSeen,
        { notificationId, revision },
      ),
    }),
    changes: Object.freeze({
      onChanged: listener => subscribe<ChangeSetChangeNotice>(LOCAL_CHAT_IPC_CHANNELS.changesChanged, listener),
      overview: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.changesOverview, { ...input }),
      get: changeSetId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.changesGet, { changeSetId }),
    }),
    runs: Object.freeze({
      list: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runsList, input ?? {}),
      get: runId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runsGet, { runId }),
      listEvents: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runsListEvents, input),
      status: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.runsStatus, { ...input }),
    }),
    approvals: Object.freeze({
      list: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.approvalsList, input ?? {}),
      approve: (approvalId, scope) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.approvalsApprove, { approvalId, scope }),
      deny: approvalId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.approvalsDeny, { approvalId }),
    }),
    usage: Object.freeze({
      getSnapshot: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.usageSnapshot),
      analytics: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.usageAnalytics, {
        startDate: input.startDate,
        endDate: input.endDate,
        timeZone: input.timeZone,
      }),
      trend: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.usageTrend, {
        startDate: input.startDate,
        endDate: input.endDate,
        timeZone: input.timeZone,
        granularity: input.granularity,
      }),
      topTasks: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.usageTopTasks, {
        startDate: input.startDate,
        endDate: input.endDate,
        timeZone: input.timeZone,
        model: input.model ? { providerId: input.model.providerId, modelId: input.model.modelId } : null,
      }),
    }),
  }
}
