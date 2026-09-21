import type { LocalChatIpcContext } from './registrar'
import { artifactsRequestSchemas, artifactsRpc } from '../../../shared/artifacts/artifactApi'
import { changeOverviewRequestSchema, changesRequestSchemas, changesRpc } from '../../../shared/changes/changeApi'
import { notificationsRequestSchemas, notificationsRpc } from '../../../shared/notifications/notificationApi'
import { approvalsRequestSchemas, approvalsRpc } from '../../../shared/permissions/approvalApi'
import { conversationStatusRequestSchema, runsStatusRpc } from '../../../shared/runs/conversationStatusApi'
import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import { runsRequestSchemas, runsResponseSchemas, runsRpc } from '../../../shared/runs/runApi'
import { usageAnalyticsRpc, usagePeriodSchema, usageTopTasksRequestSchema, usageTrendRequestSchema } from '../../../shared/usage/usageAnalyticsApi'
import { usageRpc } from '../../../shared/usage/usageApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerActivityIpc(context: LocalChatIpcContext): void {
  const { handle, request } = context
  handle(LOCAL_CHAT_IPC_CHANNELS.changesOverview, (_event, input) => request(changesRpc.overview, changeOverviewRequestSchema.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.artifactsReadText, (_event, input) => request(artifactsRpc.readText, artifactsRequestSchemas.artifactText.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.notificationsList, () => request(notificationsRpc.list, {}))

  handle(LOCAL_CHAT_IPC_CHANNELS.notificationsMarkSeen, (_event, input) => request(notificationsRpc.markSeen, notificationsRequestSchemas.notificationRevision.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.notificationsMarkAllSeen, () => request(notificationsRpc.markAllSeen, {}))

  handle(LOCAL_CHAT_IPC_CHANNELS.changesGet, (_event, input) => request(changesRpc.get, changesRequestSchemas.changeSet.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.runsList, (_event, input) => request(runsRpc.list, runsRequestSchemas.listRuns.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.runsGet, (_event, input) => request(runsRpc.get, runsRequestSchemas.runId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.runsListEvents, async (_event, input) => {
    const events = await request(runsRpc.listEvents, runsRequestSchemas.runEvents.parse(input))
    return runsResponseSchemas.runEvents.parse(events.map(toPublicRunEvent))
  })

  handle(LOCAL_CHAT_IPC_CHANNELS.runsStatus, (_event, input) => request(runsStatusRpc.status, conversationStatusRequestSchema.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.approvalsList, (_event, input) => request(approvalsRpc.list, approvalsRequestSchemas.listApprovals.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.approvalsApprove, (_event, input) => request(approvalsRpc.approve, approvalsRequestSchemas.approvalGrant.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.approvalsDeny, (_event, input) => request(approvalsRpc.deny, approvalsRequestSchemas.approvalId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.usageSnapshot, () => request(usageRpc.snapshot, {}))
  handle(LOCAL_CHAT_IPC_CHANNELS.usageAnalytics, (_event, input) => request(usageAnalyticsRpc.analytics, usagePeriodSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.usageTopTasks, (_event, input) => request(usageAnalyticsRpc.topTasks, usageTopTasksRequestSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.usageTrend, (_event, input) => request(usageAnalyticsRpc.trend, usageTrendRequestSchema.parse(input)))
}
