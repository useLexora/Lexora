import type { DatabaseSync } from 'node:sqlite'
import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import type { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import type { BuddySessionExtensionServices } from './agent/extensions/createBuddySessionExtensions'
import type { ReusableBuddySession } from './agent/sessions/ReusableBuddySession'
import type { AutomationClock } from './automations/AutomationScheduleEvaluator'
import type { BuddyRuntime } from './BuddyRuntime'
import type { RunEventLogPort } from './events/RunEventPorts'

import type { BuddyServiceRpcServer } from './rpc/BuddyServiceRpcServer'
import type { BuddyServiceErrorCode } from './rpc/runtimeRequest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { currentPlatform } from '../../platform/currentPlatform'
import { resolveWindowsPowerShell } from '../../platform/windows/powerShell'
import { artifactsChanged } from '../../shared/artifacts/artifactApi'
import { automationNotifications } from '../../shared/automation/automationApi'
import { changesChanged } from '../../shared/changes/changeApi'
import { connectorNotifications } from '../../shared/connectors/connectorApi'
import { contextPanelRpc, contextPanelStateSchema } from '../../shared/context-panel/contextPanel'
import { composerResourcesChanged } from '../../shared/conversation/composerApi'
import { CONVERSATION_CHANGED, conversationTimelineChanged } from '../../shared/conversation/conversationApi'
import { extensionActionRpc } from '../../shared/extensions/extensionActionApi'
import { extensionAgentRpc } from '../../shared/extensions/extensionAgent'
import { ServiceHost } from '../../shared/lifecycle/ServiceHost'
import { ServiceLifecycleSource } from '../../shared/lifecycle/ServiceLifecycleSource'
import { webSettingsChanged } from '../../shared/network/webApi'
import { notificationsChanged } from '../../shared/notifications/notificationApi'
import { ApplicationEvents as EventPublisher } from '../../shared/observability/ApplicationEvents'
import { observeLifecycleDiagnostics } from '../../shared/observability/lifecycleDiagnostics'
import { openExternalResultSchema } from '../../shared/runtime/credentialProtocol'
import { runtimePreferencesRpc, runtimePreferencesSchema } from '../../shared/runtime/runtimePreferences'
import { spaceChanged } from '../../shared/spaces/spaceApi'
import { PiEventBridge } from './agent/events/PiEventBridge'
import { BuddyAgentRunner } from './agent/execution/BuddyAgentRunner'
import { BuddyRunExecutionPlanner } from './agent/execution/BuddyRunExecutionPlanner'
import { BuddyTurnLauncher } from './agent/execution/BuddyTurnLauncher'
import { PiTurnExecutor } from './agent/execution/PiTurnExecutor'
import { observeSessionResourceDiagnostics } from './agent/resources/observeSessionResourceDiagnostics'
import { SessionResourceReconciler } from './agent/resources/SessionResourceReconciler'
import { bindRuntimePreferences } from './agent/sessions/bindRuntimePreferences'
import { BuddySessionBlueprintService } from './agent/sessions/BuddySessionBlueprintService'
import { BuddySessionFactory } from './agent/sessions/BuddySessionFactory'
import { BuddySessionRegistry } from './agent/sessions/BuddySessionRegistry'
import { BuddySessionRecoveryService } from './agent/sessions/recovery/BuddySessionRecoveryService'
import { inspectCommittedPiCompaction } from './agent/sessions/recovery/inspectCommittedPiCompaction'
import { BuddyConversationTree } from './agent/sessions/tree/BuddyConversationTree'
import { ApprovalService } from './approvals/ApprovalService'
import { registerApprovalRpc } from './approvals/registerApprovalRpc'
import { ArtifactService } from './artifacts/ArtifactService'
import { reconcileLegacyArtifactOutputs } from './artifacts/LegacyArtifactRecovery'
import { registerArtifactRpc } from './artifacts/registerArtifactRpc'
import { AttachmentService } from './attachments/AttachmentService'
import { ComposerResourceService } from './attachments/ComposerResourceService'
import { registerAttachmentRpc } from './attachments/registerAttachmentRpc'
import { registerComposerResourceRpc } from './attachments/registerComposerResourceRpc'
import { AgentTaskAutomationAction } from './automations/AgentTaskAutomationAction'
import { AutomationChangeCoordinator } from './automations/AutomationChangeCoordinator'
import { AutomationDispatcher } from './automations/AutomationDispatcher'
import { AutomationOccurrenceLifecycleService } from './automations/AutomationOccurrenceLifecycleService'
import { systemAutomationClock } from './automations/AutomationScheduleEvaluator'
import { AutomationScheduler } from './automations/AutomationScheduler'
import { AutomationService } from './automations/AutomationService'
import { AutomationTurnService } from './automations/AutomationTurnService'
import { registerAutomationRpc } from './automations/registerAutomationRpc'
import { resolveAutomationModelSelection } from './automations/resolveAutomationModelSelection'
import { BrowserHostClient } from './browser/BrowserHostClient'
import { ChangeCaptureService } from './changes/ChangeCaptureService'
import { createChangeSetRepository } from './changes/changeSetRepository'
import { registerChangeRpc } from './changes/registerChangeRpc'
import { ChatCommandService } from './chat/ChatCommandService'
import { ChatInputValidationService } from './chat/ChatInputValidationService'
import { ChatQueueService } from './chat/ChatQueueService'
import { ChatTurnService } from './chat/ChatTurnService'
import { ComposerDraftService } from './chat/ComposerDraftService'
import { QueueContinuation } from './chat/QueueContinuation'
import { registerChatRpc } from './chat/registerChatRpc'
import { registerComposerDraftRpc } from './chat/registerComposerDraftRpc'
import { TurnRequestService } from './chat/TurnRequestService'
import {
  HostConnectorSecretStore,
  McpConnectorService,
} from './connectors/mcp/McpConnectorService'
import { McpSessionResourceConsumer } from './connectors/mcp/McpSessionResourceConsumer'
import { observeMcpDiagnostics, observeMcpNotifications } from './connectors/mcp/observeMcpEvents'
import { registerMcpConnectorRpc } from './connectors/mcp/registerMcpConnectorRpc'
import { registerContextPanelRpc } from './context-panel/registerContextPanelRpc'
import { ContextUsageSnapshotService } from './context/ContextUsageSnapshotService'
import { registerContextRpc } from './context/registerContextRpc'
import { ConversationLifecycleService } from './conversations/ConversationLifecycleService'
import { ConversationMetadataService } from './conversations/ConversationMetadataService'
import { createExtensionTaskCapabilities } from './conversations/extensionTaskCapabilities'
import { ExtensionTaskContext } from './conversations/ExtensionTaskContext'
import { registerConversationRpc } from './conversations/registerConversationRpc'
import { registerConversationTreeRpc } from './conversations/registerConversationTreeRpc'
import { registerTaskMarkRpc } from './conversations/registerTaskMarkRpc'
import { TaskAttentionProjection } from './conversations/TaskAttentionProjection'
import { TaskMarkService } from './conversations/TaskMarkService'
import { createBuddyCapabilityFactory } from './createBuddyCapabilityFactory'
import { DirectoryGrantService } from './directories/DirectoryGrantService'
import { observeRunDiagnostics } from './events/observeRunDiagnostics'
import { observeImageDiagnostics } from './images/ImageOperationLifecycle'
import { ImageTransformService } from './images/ImageTransformService'
import { OpenAiImageGenerationService } from './images/OpenAiImageGenerationService'
import { AttentionNotificationService } from './notifications/AttentionNotificationService'
import { NotificationProjection } from './notifications/NotificationProjection'
import { registerNotificationRpc } from './notifications/registerNotificationRpc'
import { observePetActionDiagnostics } from './pet/observePetActionDiagnostics'
import { PetActionService } from './pet/PetActionService'
import { bindExtensionActions } from './plugins/bindExtensionActions'
import { ExtensionActionService } from './plugins/ExtensionActionService'
import { ExtensionAgentRuntime } from './plugins/ExtensionAgentRuntime'
import { observeExtensionAgentDiagnostics } from './plugins/observeExtensionAgentDiagnostics'
import { PluginAuthoringService } from './plugins/PluginAuthoringService'
import { registerExtensionConditionRpc } from './plugins/registerExtensionConditionRpc'
import { createProviderService } from './providers/createProviderService'

import { createExtensionModelCapabilities } from './providers/extensionModelCapabilities'
import { ProviderDependents } from './providers/ProviderDependents'
import { registerProviderRpc } from './providers/registerProviderRpc'
import { resolveInteractiveModelSelection } from './providers/resolveInteractiveModelSelection'
import { BuddyServiceError, registerRuntimeRequest } from './rpc/runtimeRequest'
import { registerRunRpc } from './runs/registerRunRpc'
import { RunContinuityService } from './runs/RunContinuityService'
import { RunLifecycleService } from './runs/RunLifecycleService'
import { RunRecoveryService } from './runs/RunRecoveryService'
import { observeSandboxClient } from './sandbox/observeSandboxClient'
import { ShellSandboxClient } from './sandbox/ShellSandboxClient'
import { observeSkillDiagnostics, observeSkillNotifications } from './skills/observeSkillEvents'
import {
  registerSkillServiceRpc,
  SkillService,
} from './skills/SkillService'
import { registerSpaceFileRpc } from './spaces/registerSpaceFileRpc'
import { registerSpaceRpc } from './spaces/registerSpaceRpc'
import { SpaceDependents } from './spaces/SpaceDependents'
import { matchesSpaceExecutionContext } from './spaces/spaceExecutionContext'
import { SpaceFileService } from './spaces/SpaceFileService'
import { SpaceService } from './spaces/SpaceService'
import { createApprovalRepository } from './storage/approvalRepository'
import { createArtifactRepository } from './storage/artifactRepository'
import { createAttachmentRepository } from './storage/attachmentRepository'
import { createAutomationRepositories } from './storage/automationRepository'
import { createAutomationTurnRepository } from './storage/automationTurnRepository'
import { BuddyDataPaths } from './storage/BuddyDataPaths'
import { createChatQueueRepository } from './storage/chatQueueRepository'
import { createCommandRequestRepository } from './storage/commandRequestRepository'
import { createComposerDraftRepository } from './storage/composerDraftRepository'
import { createComposerResourceRepository } from './storage/composerResourceRepository'
import { createConnectorRepository } from './storage/connectorRepository'
import { createConversationDeletionRepository } from './storage/conversationDeletionRepository'
import { createConversationDirectoryGrantRepository } from './storage/conversationDirectoryGrantRepository'
import { createConversationHistoryStore } from './storage/conversationHistoryRepository'
import { createConversationRepository } from './storage/conversationRepository'
import { createConversationTreeRepository } from './storage/conversationTreeRepository'
import { createExtensionInvocationRepository } from './storage/extensionInvocationRepository'
import { createExtensionTaskContextRepository } from './storage/extensionTaskContextRepository'
import { createNotificationAttentionRepository } from './storage/notificationAttentionRepository'
import { createProviderRepository } from './storage/providerRepository'
import { createRunInputRepository } from './storage/runInputRepository'
import { createRunRepository } from './storage/runRepository'
import { createSkillRepository } from './storage/skillRepository'
import { createSpaceRepository } from './storage/spaceRepository'
import { createTaskMarkRepository } from './storage/taskMarkRepository'
import { createTurnRequestRepository } from './storage/turnRequestRepository'
import { createUsageAnalyticsRepository } from './storage/usageAnalyticsRepository'
import { createUsageRepository } from './storage/usageRepository'
import { createWorkspaceRepository } from './storage/workspaceRepository'
import { registerUsageRpc } from './usage/registerUsageRpc'
import { UsageService } from './usage/UsageService'
import { observeWebDiagnostics, observeWebHostDiagnostics } from './web/observeWebDiagnostics'
import { WebCapabilityService } from './web/WebCapabilityService'
import { WebHostClient } from './web/WebHostClient'
import { registerWebSettingsRpc, WebSettingsService } from './web/WebSettingsService'
import { normalizeComposerWorkspace } from './workspace/normalizeComposerWorkspace'
import { registerWorkspaceStateRpc } from './workspace/registerWorkspaceStateRpc'
import { WorkspaceStateService } from './workspace/WorkspaceStateService'

export interface StartBuddyServiceOptions {
  record?: ApplicationDiagnosticReporter
  events?: ApplicationEvents
  lifecycle?: ServiceLifecycleSource
  automationClock?: AutomationClock
  buddyHome: string
  builtinSkillsDirectories?: readonly string[]
  database: DatabaseSync
  rpc: BuddyServiceRpcServer
  eventLog: RunEventLogPort
}

export interface BuddyServiceHandle {
  dispose: () => Promise<void>
  runtime: BuddyRuntime
}

export async function startBuddyService(
  options: StartBuddyServiceOptions,
): Promise<BuddyServiceHandle> {
  const events = options.events ?? new EventPublisher()
  if (options.record)
    events.subscribe(options.record)
  const record = events.publish
  const host = new ServiceHost(options.lifecycle ?? new ServiceLifecycleSource(() => record({ event: 'observer.failed', component: 'runtime.lifecycle', level: 'warn' })))
  const stopLifecycleDiagnostics = options.lifecycle ? () => {} : observeLifecycleDiagnostics(host.lifecycle, events)
  try {
    const paths = new BuddyDataPaths(options.buddyHome)
    const agentDirectory = join(options.buddyHome, 'agent')
    await host.step('runtime.filesystem', async () => {
      if (currentPlatform.shell === 'powershell')
        process.env.PI_POWERSHELL_PATH ??= await resolveWindowsPowerShell()
      await Promise.all([
        mkdir(agentDirectory, { mode: 0o700, recursive: true }),
        mkdir(paths.conversationsDirectory, { mode: 0o700, recursive: true }),
        mkdir(paths.draftsDirectory, { mode: 0o700, recursive: true }),
      ])
    })

    const spacesRepository = createSpaceRepository(options.database)
    const conversations = createConversationRepository(options.database)
    const runs = createRunRepository(options.database)
    await host.start('runtime.run_diagnostics', ({ defer }) => {
      const subscription = observeRunDiagnostics(options.eventLog, runs, record)
      defer(() => subscription.dispose())
    })
    const conversationDirectoryGrants = createConversationDirectoryGrantRepository(options.database)
    const taskMarkRepository = createTaskMarkRepository(options.database)
    const taskMarks = await host.start('runtime.task_marks', ({ defer }) => {
      const service = new TaskMarkService(taskMarkRepository, () => record({ event: 'observer.failed', component: 'runtime.task_marks', level: 'warn' }))
      const diagnostics = service.onDidCommit(event => record({
        event: `task.mark.${event.kind}`,
        level: 'info',
        operationId: event.commitId,
        ...('markId' in event ? { markId: event.markId } : {}),
        ...(event.kind === 'attention' ? { conversationId: event.conversationId, revision: event.state.readRevision } : {}),
        ...(event.kind === 'deleted' ? { count: event.conversationIds.length } : {}),
      }))
      defer(() => {
        service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const taskAttention = await host.start('runtime.task_attention', ({ defer }) => {
      const projection = new TaskAttentionProjection({
        marks: taskMarks,
        eventLog: options.eventLog,
        repository: taskMarkRepository,
        runs,
        onError: () => record({ event: 'task.attention.reconciliation_failed', level: 'warn' }),
      })
      const diagnostics = projection.onDidChange(event => record({ event: 'task.attention.changed', level: 'info', revision: event.revision, count: event.conversationIds.length }))
      defer(() => {
        projection.dispose()
        diagnostics.dispose()
      })
      return projection
    })
    const runInputs = createRunInputRepository(options.database)
    const approvalsRepository = createApprovalRepository(options.database)
    const usageRepository = createUsageRepository(options.database)
    const workspace = createWorkspaceRepository(options.database)
    const turnRequests = await host.start('runtime.turn_requests', ({ defer }) => {
      const service = new TurnRequestService(createTurnRequestRepository(options.database), () => record({ event: 'observer.failed', component: 'runtime.turn_requests', level: 'warn' }))
      const notifications = service.onDidCommit((event) => {
        const conversation = conversations.findById(event.conversationId)
        if (conversation)
          options.rpc.notify(CONVERSATION_CHANGED, conversation)
      })
      const diagnostics = service.onDidCommit((event) => {
        for (const fact of event.facts)
          record({ event: fact.kind, level: 'info', operationId: event.commitId, runId: event.runId, conversationId: event.conversationId, branchId: event.branchId, requestId: event.requestId, ...(fact.kind === 'draft.consumed' ? { revision: fact.receipt.committedRevision } : {}), ...(fact.kind === 'attachments.bound' ? { count: fact.attachmentIds.length } : {}) })
      })
      defer(() => {
        service.dispose()
        notifications.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const composerDrafts = createComposerDraftRepository(options.database)
    const commandRequests = createCommandRequestRepository(options.database)
    const connectorsRepository = createConnectorRepository(options.database)
    const spaceService = await host.start('runtime.spaces', ({ defer }) => {
      const service = new SpaceService(spacesRepository, () => record({ event: 'space.observer.failed', level: 'warn' }))
      const notices = service.onDidCommit(({ sourceId, revision, spaceId, kind }) => options.rpc.notify(spaceChanged.method, { sourceId, revision, spaceId, kind }))
      const diagnostics = service.onDidCommit(event => record({ event: `space.${event.kind.replaceAll('-', '_')}`, level: 'info', spaceId: event.spaceId, revision: event.revision, count: event.directories.length }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
        notices.dispose()
      })
      return service
    })
    const spaceFiles = await host.start('runtime.space_files', ({ defer }) => {
      const service = new SpaceFileService(spacesRepository)
      const diagnostics = service.onDidChange(event => record({ event: `space.file.${event.kind.replaceAll('-', '_')}`, level: event.kind === 'response-denied' ? 'warn' : 'info', operationId: event.operationId, spaceId: event.spaceId, directoryId: event.directoryId, revision: event.revision }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    }, ['runtime.spaces'])
    let runner!: BuddyAgentRunner
    const approvalService = await host.start('runtime.approvals', ({ defer }) => {
      const service = new ApprovalService({
        eventLog: options.eventLog,
        onExpired: async (runId) => {
          await runner.cancel(runId, 'AUTOMATION_APPROVAL_EXPIRED')
        },
        repository: approvalsRepository,
        onObserverError: () => record({ event: 'observer.failed', component: 'runtime.approvals', level: 'warn' }),
      })
      const diagnostics = service.onDidChange(event => record({
        event: `approval.${event.kind}${'reason' in event ? `.${event.reason}` : 'scope' in event ? `.${event.scope}` : ''}`,
        level: event.kind === 'cancellation.failed' || ('persistence' in event && event.persistence === 'failed') ? 'warn' : 'info',
        runId: event.runId,
        ...('approvalId' in event ? { operationId: event.approvalId } : 'requestId' in event ? { operationId: event.requestId } : {}),
        ...('toolCallId' in event ? { toolCallId: event.toolCallId } : {}),
        ...('count' in event ? { count: event.count } : {}),
        ...('durationMs' in event ? { durationMs: event.durationMs } : {}),
        ...('persistence' in event && event.persistence === 'failed' ? { errorCode: 'APPROVAL_PERSISTENCE_FAILED' } : {}),
        ...('errorCode' in event ? { errorCode: event.errorCode } : {}),
      }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const usageService = await host.start('runtime.usage', ({ defer }) => {
      const service = new UsageService({
        eventLog: options.eventLog,
        repository: usageRepository,
        onObserverError: () => record({ event: 'usage.observer_failed', level: 'warn' }),
      })
      const diagnostics = service.onDidRecord(event => record({ event: 'usage.committed', level: 'info', operationId: event.invocationId ?? event.id, runId: event.runId ?? undefined }))
      defer(() => {
        service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const piEventBridge = new PiEventBridge({
      record,
      eventLog: options.eventLog,
      usage: usageService,
    })
    const runLifecycleService = await host.start('runtime.run_lifecycle', ({ defer }) => {
      const service = new RunLifecycleService({ record, eventLog: options.eventLog, repository: runs })
      const diagnostics = service.onDidReconcile(event => record({ event: 'run.sql_reconciled', level: 'error', runId: event.runId, conversationId: event.conversationId, branchId: event.branchId, errorCode: event.errorCode ?? 'EVENT_LOG_FAILED' }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const runContinuity = await host.start('runtime.run_continuity', ({ defer }) => {
      const service = new RunContinuityService(runs, () => record({ event: 'observer.failed', component: 'runtime.run_continuity', level: 'warn' }))
      const diagnostics = service.onDidCommit(event => record({ event: `run.continuity.${event.kind}`, level: 'info', operationId: event.operationId, conversationId: event.conversationId, branchId: event.branchId, revision: event.revision, count: event.runIds.length }))
      defer(() => {
        service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const changeCaptureService = await host.start('runtime.change_capture', ({ defer }) => {
      const service = new ChangeCaptureService({ paths, repository: createChangeSetRepository(options.database), onListenerError: () => record({ event: 'observer.failed', component: 'runtime.change_capture', level: 'warn' }) })
      service.onDidChange(event => record({ event: `changes.${event.kind.replaceAll('-', '_')}`, level: event.errorCode ? 'warn' : 'info', producerInstanceId: event.sourceId, operationId: event.operationId, conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, revision: event.revision, count: event.count, errorCode: event.errorCode }))
      service.onDidChange((event) => {
        if (event.conversationId && !event.errorCode)
          options.rpc.notify(changesChanged.method, { sourceId: event.sourceId, revision: event.revision, conversationId: event.conversationId, runId: event.runId })
      })
      defer(() => service.dispose())
      return service
    })
    const runRecoveryService = new RunRecoveryService({
      cancelPendingApprovals: () => approvalService.cancelPendingApprovals(),
      captureInterruptedChanges: async (runId) => {
        await changeCaptureService.markInterrupted(runId)
      },
      conversations,
      eventLog: options.eventLog,
      lifecycle: runLifecycleService,
      inspectCommittedCompaction: run => inspectCommittedPiCompaction({
        branchId: run.branchId,
        conversationsDirectory: paths.conversationsDirectory,
        conversationId: run.conversationId,
        piSessionFile: requireValue(run.piSessionFile, 'VALIDATION_FAILED'),
        startedAt: run.startedAt,
      }),
      repository: runs,
      usage: usageService,
    })
    const attachmentService = await host.start('runtime.attachment_storage', ({ defer }) => {
      const service = new AttachmentService({ paths, repository: createAttachmentRepository(options.database) })
      service.onDidChange(event => record({ event: `attachment.${event.kind.replaceAll('-', '_')}`, level: event.kind === 'cleanup-failed' ? 'warn' : 'info', operationId: event.operationId, revision: event.revision, count: event.count }))
      defer(() => service.dispose())
      return service
    })
    const artifactsRepository = createArtifactRepository(options.database)
    const artifactService = await host.start('runtime.artifact_catalogue', ({ defer }) => {
      const service = new ArtifactService({ repository: artifactsRepository, onListenerError: () => record({ event: 'observer.failed', component: 'runtime.artifact_catalogue', level: 'warn' }) })
      service.onDidChange(event => record({ event: `artifact.${event.receipt.cause}.${event.kind.replaceAll('-', '_')}${event.kind === 'batch-settled' ? `.${event.receipt.outcome}.${event.receipt.stage}` : ''}`, level: event.errorCode ? 'warn' : 'info', producerInstanceId: event.sourceId, operationId: event.receipt.operationId, conversationId: event.receipt.conversationId, revision: event.revision, count: event.kind === 'file-written' ? event.receipt.written : event.receipt.artifactIds.length, errorCode: event.errorCode }))
      service.onDidChange((event) => {
        if (event.kind === 'catalogue-committed')
          options.rpc.notify(artifactsChanged.method, { sourceId: event.sourceId, revision: event.revision, conversationId: event.receipt.conversationId })
      })
      defer(() => service.dispose())
      return service
    })
    await host.step('runtime.artifacts', () => reconcileLegacyArtifactOutputs({
      artifacts: artifactsRepository,
      catalogue: artifactService,
      conversations,
      eventLog: options.eventLog,
      paths,
    }))
    const composerResourceService = await host.start('runtime.composer_resources', ({ defer }) => {
      const service = new ComposerResourceService({ artifacts: artifactService, attachments: attachmentService, conversationGrants: conversationDirectoryGrants, conversations, drafts: composerDrafts, eventLog: options.eventLog, paths, repository: createComposerResourceRepository(options.database), spaces: spacesRepository })
      service.onDidChange(event => options.rpc.notify(composerResourcesChanged.method, { revision: event.revision, draftIds: [...new Set(event.resources.map(resource => resource.draftId))] }))
      service.onDidChange(event => record({ event: 'composer.resources.committed', level: 'info', operationId: event.operationId, revision: event.revision, count: event.resources.length }))
      defer(() => service.dispose())
      return service
    }, ['runtime.attachment_storage'])
    const workspaceStateService = await host.start('runtime.workspace_state', ({ defer }) => {
      const service = new WorkspaceStateService({ repository: workspace, normalize: value => normalizeComposerWorkspace(value, { conversations, resources: composerResourceService }) })
      service.onDidChange(event => record({ event: `workspace.state.${event.kind.replaceAll('-', '_')}`, level: event.kind === 'normalization-failed' ? 'warn' : 'info', operationId: event.operationId, revision: event.revision }))
      defer(() => service.dispose())
      return service
    }, ['runtime.composer_resources'])
    await host.step('runtime.attachments', async () => {
      const attachmentRecovery = await attachmentService.reconcileStorage()
      composerResourceService.recoverInterruptedImports([
        ...attachmentRecovery.invalidAttachmentIds,
        ...attachmentRecovery.missingAttachmentIds,
      ])
      await composerResourceService.cleanupDrafts()
    })
    const imageTransformService = await host.start('runtime.image_transform', ({ defer }) => {
      const service = new ImageTransformService({ artifacts: artifactService })
      const diagnostics = observeImageDiagnostics(service, record)
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    }, ['runtime.artifact_catalogue'])
    const providersRepository = createProviderRepository(options.database)
    const providerService = await host.start('runtime.providers', async ({ defer }) => {
      const service = await createProviderService({
        agentDirectory,
        database: options.database,
        getActiveRuns: () => runs.listIncomplete(),
        peer: options.rpc,
        providers: providersRepository,
        record,
      })
      defer(() => service.dispose())
      return service
    })
    const executionModels = providerService.executionModels
    const imageGenerationGateway = new OpenAiImageGenerationService({
      modelRuntime: executionModels.getRuntime(),
      resolveSourceProviderId: providerId => executionModels.resolveSourceProviderId(providerId),
    })
    const sessions = await host.start('runtime.sessions', () => new BuddySessionRegistry<ReusableBuddySession>())
    const conversationMetadata = await host.start('runtime.task_metadata', ({ defer }) => {
      const service = new ConversationMetadataService({
        repository: conversations,
        sessions: { invalidateConversation: id => sessions.invalidateConversationWithResult(id) },
        resolveModelSelection: selection => resolveInteractiveModelSelection(providerService, selection),
        onObserverError: () => record({ event: 'task.observer_failed', level: 'warn' }),
      })
      const notification = service.onDidCommit(event => options.rpc.notify(CONVERSATION_CHANGED, event.conversation))
      const diagnostics = service.onDidCommit(event => record({
        event: `task.${event.kind}.committed`,
        level: 'info',
        conversationId: event.conversation.id,
        operationId: event.commitId,
      }))
      defer(async () => {
        await service.dispose()
        notification.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const extensionHistory = createExtensionTaskContextRepository(options.database, createConversationHistoryStore(options.database).lineage)
    const extensionTaskContext = new ExtensionTaskContext(conversations, extensionHistory, runs, runInputs)
    const extensionAgent = await host.start('runtime.plugins', ({ defer }) => {
      const service = new ExtensionAgentRuntime({
        rpc: options.rpc,
        createHandlers: (scope) => {
          const task = extensionTaskContext.open(scope)
          return {
            ...createExtensionTaskCapabilities(conversationMetadata, extensionHistory, task, scope),
            ...createExtensionModelCapabilities(executionModels, usageService, task),
          }
        },
        onObserverError: () => record({ event: 'plugins.observer_failed', level: 'warn' }),
      })
      const binding = service.bind()
      const diagnostics = observeExtensionAgentDiagnostics(service, record)
      defer(async () => {
        binding()
        try {
          await service.dispose()
        }
        finally {
          diagnostics.dispose()
        }
      })
      defer(options.rpc.onNotification((method) => {
        if (method === extensionAgentRpc.changed)
          void sessions.invalidateMode('interactive').catch(() => record({ event: 'plugins.sessions_invalidation.failed', level: 'warn', errorCode: 'EXTENSION_INVALIDATION_FAILED' }))
      }))
      return service
    })
    const pluginBuilder = await host.start('runtime.plugin_authoring', ({ defer }) => {
      const service = new PluginAuthoringService(options.rpc, () => record({ event: 'plugins.authoring.observer_failed', level: 'warn' }))
      const diagnostics = service.onDidChange(event => record({ event: `plugins.authoring.${event.kind.replaceAll('-', '_')}`, level: event.errorCode ? 'warn' : 'info', extensionId: event.extensionId, operationId: event.operationId, conversationId: event.conversationId, runId: event.runId, count: event.bytes, ...(event.errorCode ? { errorCode: event.errorCode } : {}) }))
      defer(async () => {
        try {
          await service.dispose()
        }
        finally {
          diagnostics.dispose()
        }
      })
      return service
    })
    const directoryGrants = await host.start('runtime.directory_grants', ({ defer }) => {
      const service = new DirectoryGrantService({
        conversationGrants: conversationDirectoryGrants,
        conversations,
        spaces: spaceService,
        onListenerError: () => record({ event: 'directory.observer.failed', level: 'warn' }),
      })
      const diagnostics = service.onDidCommit(event => record({ event: 'directory.conversation.committed', level: 'info', conversationId: event.conversationId, directoryId: event.grantId, revision: event.revision, count: event.revokedGrantIds.length }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    }, ['runtime.spaces'])
    const connectorService = await host.start('runtime.connectors', ({ defer }) => {
      const service = new McpConnectorService({
        connectors: connectorsRepository,
        openExternal: async (url) => {
          const result = openExternalResultSchema.parse(await options.rpc.request('host.openExternal', { url }))
          if (!result.ok)
            throw new Error('MCP authorization page is unavailable')
        },
        onListenerError: () => record({ event: 'connectors.observer.failed', level: 'warn', errorCode: 'MCP_OBSERVER_FAILED' }),
        secrets: new HostConnectorSecretStore(options.rpc),
      })
      const diagnostics = observeMcpDiagnostics(service, record)
      const notifications = observeMcpNotifications(service, event => options.rpc.notify(connectorNotifications.changed.method, event))
      defer(async () => {
        try {
          await service.close()
        }
        finally {
          diagnostics.dispose()
          notifications.dispose()
        }
      })
      return service
    })
    const { skillService, sessionResources } = await host.start('runtime.skills', async ({ defer }) => {
      const skillService = new SkillService({
        agentDirectory,
        builtinSkillsDirectories: options.builtinSkillsDirectories,
        spaces: spacesRepository,
        repository: createSkillRepository(options.database),
        paths,
        onListenerError: () => record({ event: 'skills.observer.failed', level: 'warn', errorCode: 'SKILL_OBSERVER_FAILED' }),
      })
      const sessionResources = new SessionResourceReconciler({
        skills: skillService,
        sessions,
        onListenerError: () => record({ event: 'sessions.resources.observer_failed', level: 'warn', errorCode: 'SESSION_RESOURCE_OBSERVER_FAILED' }),
      })
      const resourceDiagnostics = observeSessionResourceDiagnostics(sessionResources, record)
      const skillDiagnostics = observeSkillDiagnostics(skillService, record)
      const notifications = observeSkillNotifications(skillService, event => options.rpc.notify('skills.changed', event))
      defer(async () => {
        try {
          try {
            await sessionResources.dispose()
          }
          finally {
            await skillService.dispose()
          }
        }
        finally {
          resourceDiagnostics.dispose()
          skillDiagnostics.dispose()
          notifications.dispose()
        }
      })
      await skillService.initialize()
      return { skillService, sessionResources }
    })
    await host.start('runtime.connector-resources', ({ defer }) => {
      const consumer = new McpSessionResourceConsumer({ service: connectorService, sessions, resources: sessionResources, report: record })
      defer(() => consumer.dispose())
      connectorService.start()
      return consumer
    })
    const browserHost = new BrowserHostClient(options.rpc)
    const webSettings = await host.start('runtime.web_settings', ({ defer }) => {
      const service = new WebSettingsService(workspace, options.rpc)
      const notifications = service.onDidChange(change => options.rpc.notify(webSettingsChanged.method, { operationId: change.operationId, revision: change.revision }))
      const diagnostics = service.onDidChange(change => record({ event: `web.settings.${change.kind.replaceAll('-', '_')}`, level: change.kind === 'credential-failed' ? 'warn' : 'info', operationId: change.operationId, revision: change.revision }))
      defer(async () => {
        await service.dispose()
        notifications.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const webHost = await host.start('runtime.web_host', ({ defer }) => {
      const client = new WebHostClient(options.rpc)
      const diagnostics = observeWebHostDiagnostics(client, record)
      defer(async () => {
        await client.dispose()
        diagnostics.dispose()
      })
      return client
    })
    const webService = await host.start('runtime.web', ({ defer }) => {
      const service = new WebCapabilityService({
        host: webHost,
        models: executionModels.getRuntime(),
        paths,
        settings: webSettings,
      })
      const diagnostics = observeWebDiagnostics(service, record)
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const automationClock = options.automationClock ?? systemAutomationClock
    const automationRepositories = createAutomationRepositories(options.database)
    const automationTurns = await host.start('runtime.automation_turns', ({ defer }) => {
      const service = new AutomationTurnService(createAutomationTurnRepository(options.database), () => record({ event: 'automation.turn_observer_failed', level: 'warn' }))
      const notifications = service.onDidCommit((event) => {
        for (const fact of event.facts) {
          if (fact.kind !== 'task.created')
            continue
          const conversation = conversations.findById(fact.conversationId)
          if (conversation)
            options.rpc.notify(CONVERSATION_CHANGED, conversation)
        }
      })
      const diagnostics = service.onDidCommit((event) => {
        for (const fact of event.facts) {
          record({ event: `automation.${fact.kind}`, level: 'info', operationId: event.operationId, revision: event.revision, automationId: fact.automationId, ...('occurrenceId' in fact ? { occurrenceId: fact.occurrenceId } : {}), ...('runId' in fact ? { runId: fact.runId ?? undefined } : {}), ...('conversationId' in fact ? { conversationId: fact.conversationId ?? undefined } : {}) })
        }
      })
      defer(() => {
        service.dispose()
        notifications.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const automationService = await host.start('runtime.automation_definitions', ({ defer }) => {
      const service = new AutomationService({
        clock: automationClock,
        repositories: automationRepositories,
        onObserverError: () => record({ event: 'automation.observer_failed', level: 'warn' }),
      })
      const diagnostics = service.onDidCommit((event) => {
        for (const fact of event.facts) {
          record({ event: `automation.${fact.kind}`, level: 'info', operationId: event.operationId, revision: event.revision, automationId: fact.automationId, ...('occurrenceId' in fact ? { occurrenceId: fact.occurrenceId } : {}), ...('errorCode' in fact && fact.errorCode ? { errorCode: fact.errorCode } : {}) })
        }
      })
      defer(() => {
        service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const notificationService = await host.start('runtime.notifications', ({ defer }) => {
      const service = new AttentionNotificationService({
        attention: createNotificationAttentionRepository(options.database),
        listAutomationRuns: () => automationService.listHistory({ limit: 100 }).items.flatMap(
          (occurrence) => {
            if (!occurrence.runId || !occurrence.conversationId)
              return []
            const run = runs.findById(occurrence.runId)
            if (!run?.completedAt || (run.status !== 'completed' && run.status !== 'failed'))
              return []
            return [{
              automationId: occurrence.automationId,
              automationName: occurrence.executionSnapshot.name,
              completedAt: run.completedAt,
              conversationId: occurrence.conversationId,
              errorCode: run.errorCode,
              runId: run.id,
              status: run.status,
            }]
          },
        ),
        listModels: () => providersRepository.models.list(),
      })
      const changed = service.onDidCommit(event => options.rpc.notify(notificationsChanged.method, { revision: event.revision }))
      const diagnostics = service.onDidCommit(event => record({ event: `notifications.${event.reason}`, level: 'info', operationId: event.operationId, revision: event.revision, count: event.changes.length }))
      const projection = new NotificationProjection({ service, providers: providerService, automations: automationService, runs: options.eventLog, lifecycle: runLifecycleService, record })
      defer(async () => {
        await projection.dispose()
        service.dispose()
        changed.dispose()
        diagnostics.dispose()
      })
      return service
    })
    let automationScheduler: AutomationScheduler | null = null
    let automationDispatcher: AutomationDispatcher | null = null
    let stopExecution: () => Promise<void> = async () => {}
    const automationChanges = await host.start('runtime.automation_changes', ({ defer }) => {
      const consumer = new AutomationChangeCoordinator({
        notify: automationId => options.rpc.notify(automationNotifications.changed.method, { automationId }),
        service: automationService,
        turns: automationTurns,
        runChanges: { eventLog: options.eventLog, lifecycle: runLifecycleService, runs },
        wakeScheduler: () => automationScheduler?.wake(),
        onError: () => record({ event: 'automation.projection.degraded', level: 'warn' }),
      })
      defer(() => consumer.dispose())
      return consumer
    })
    automationChanges.reconcileDependencies({
      isPinnedModelAvailable(providerId, modelId) {
        const provider = providersRepository.states.findByProviderId(providerId)
        const model = providersRepository.models.find(providerId, modelId)
        return Boolean(provider?.enabled && model?.enabled && model.available)
      },
      isSpaceAvailable(spaceId) {
        const space = spacesRepository.findById(spaceId)
        return Boolean(space && space.revokedAt === null)
      },
    })
    await host.start('runtime.provider_dependencies', ({ defer }) => {
      const consumer = new ProviderDependents({ source: providerService, sessions, resources: sessionResources, automations: automationChanges, record })
      defer(() => consumer.dispose())
      return consumer
    }, ['runtime.providers', 'runtime.sessions'])
    await host.start('runtime.space_dependencies', ({ defer }) => {
      const consumer = new SpaceDependents({ source: spaceService, grants: directoryGrants, sessions, resources: sessionResources, automations: automationChanges, record })
      defer(() => consumer.dispose())
      return consumer
    }, ['runtime.spaces', 'runtime.directory_grants', 'runtime.sessions'])
    let chatQueueService: ChatQueueService | undefined
    const petActions = await host.start('runtime.pet_actions', ({ defer }) => {
      const service = new PetActionService({ eventSink: event => options.eventLog.append(event), peer: options.rpc })
      const diagnostics = observePetActionDiagnostics(service, record)
      defer(async () => {
        try {
          await service.dispose()
        }
        finally {
          diagnostics.dispose()
        }
      })
      return service
    })
    const sessionExtensionServices: BuddySessionExtensionServices = {
      followUp: async (runId, signal) => { await chatQueueService?.followUp(runId, signal) },
      prepareForRun: signal => connectorService.prepareForRun(signal),
      shellSandbox: await host.start('runtime.shell_sandbox', ({ defer }) => {
        const sandbox = new ShellSandboxClient(options.rpc)
        const diagnostics = observeSandboxClient(sandbox, record)
        defer(async () => {
          await sandbox.dispose()
          diagnostics.dispose()
        })
        return sandbox
      }),
      approvalService,
      attachmentService,
      changeCaptureService,
      directoryGrants,
      recordPermissions: record,
      createCapabilities: createBuddyCapabilityFactory(currentPlatform, {
        record,
        pluginAuthoring: options.rpc,
        pluginBuilder,
        pluginCapabilities: context => extensionAgent.capabilities(context),
        artifactService,
        attachmentService,
        automationService,
        browserHost,
        presentBrowser: async (source) => {
          try {
            contextPanelStateSchema.parse(await options.rpc.request(contextPanelRpc.presentBrowser, source))
          }
          catch {
            record({ event: 'context_panel.presentation.failed', level: 'warn', errorCode: 'CONTEXT_PANEL_UNAVAILABLE' })
          }
        },
        connectorService,
        imageGenerationGateway,
        imageTransformService,
        webService,
      }, petActions),
    }
    const sessionBlueprints = new BuddySessionBlueprintService({
      conversationGrants: conversationDirectoryGrants,
      paths,
      spaces: spacesRepository,
      skills: skillService,
    })
    const sessionRecovery = new BuddySessionRecoveryService({
      usage: usageRepository,
      attachments: attachmentService,
      conversations,
      models: executionModels,
      runInputs,
      runs,
    })
    const conversationTree = await host.start('runtime.conversation_tree', ({ defer }) => {
      const service = new BuddyConversationTree({
        conversationsDirectory: paths.conversationsDirectory,
        conversations,
        repository: createConversationTreeRepository(options.database),
        runs,
        recovery: sessionRecovery,
        onObserverError: () => record({ event: 'tree.observer_failed', level: 'warn' }),
      })
      const commits = service.onDidCommit(event => record({
        event: event.kind === 'checkpoint.committed'
          ? `tree.checkpoint.${event.position}.${event.recovery?.source ?? 'execution'}.committed`
          : event.kind === 'binding.committed' ? `tree.binding.${event.reason}` : `tree.${event.kind}`,
        level: 'info',
        operationId: event.operationId,
        conversationId: event.conversationId,
        generation: event.treeId,
        revision: event.revision,
        ...('runId' in event ? { runId: event.runId, branchId: event.branchId } : {}),
        ...(event.kind === 'entries.imported' ? { count: event.entryCount } : {}),
        ...(event.kind === 'checkpoint.committed' && event.recovery?.missingAttachmentCount !== undefined ? { count: event.recovery.missingAttachmentCount } : {}),
      }))
      const failures = service.onDidFail(event => record({ event: `tree.${event.stage}.failed`, level: 'warn', operationId: event.operationId, conversationId: event.conversationId, errorCode: event.errorCode }))
      defer(async () => {
        await service.dispose()
        commits.dispose()
        failures.dispose()
      })
      return service
    })
    const sessionFactory = await host.start('runtime.session_factory', () => {
      const service = new BuddySessionFactory({
        bindPreferences: apply => bindRuntimePreferences(options.rpc, apply),
        tree: conversationTree,
        events,
        agentDirectory,
        conversations,
        conversationsDirectory: paths.conversationsDirectory,
        models: executionModels,
        runs,
        services: sessionExtensionServices,
      })
      return service
    })
    const piTurnExecutor = new PiTurnExecutor({
      eventLog: options.eventLog,
      piEvents: piEventBridge,
      continuity: runContinuity,
      sessionFactory: input => sessionFactory.create(input),
      sessions,
    })
    runner = await host.start('runtime.execution', ({ defer }) => {
      const service = new BuddyAgentRunner({
        executor: piTurnExecutor,
        lifecycle: runLifecycleService,
        releaseRunResources: runId => approvalService.clearRunAuthorizations(runId),
        onObserverError: () => record({ event: 'execution.observer_failed', level: 'error' }),
        sessions,
      })
      const settledDiagnostics = service.onDidSettle(settled => record({
        event: 'execution.settled',
        level: settled.cleanup === 'degraded' ? 'warn' : 'info',
        runId: settled.runId,
        conversationId: settled.conversationId,
        operationId: settled.executionId,
        ...(settled.cleanup === 'degraded' ? { errorCode: 'EXECUTION_CLEANUP_DEGRADED' } : {}),
      }))
      let stopped: Promise<void> | undefined
      stopExecution = () => stopped ??= (async () => {
        const scanning = automationScheduler?.dispose()
        automationDispatcher?.stop()
        const errors: unknown[] = []
        await scanning?.catch(error => errors.push(error))
        await service.dispose().catch(error => errors.push(error))
        await automationDispatcher?.dispose().catch(error => errors.push(error))
        await automationScheduler?.settle().catch(error => errors.push(error))
        if (errors.length)
          throw new AggregateError(errors, 'Automation and execution cleanup failed')
      })()
      defer(async () => {
        try {
          await stopExecution()
        }
        finally {
          settledDiagnostics.dispose()
        }
      })
      return service
    })
    const conversationLifecycle = await host.start('runtime.task_deletion', ({ defer }) => {
      const service = new ConversationLifecycleService({
        conversations,
        deletion: createConversationDeletionRepository(options.database),
        runner,
        cancelQueuedRuns: async (conversationId) => {
          for (const run of runs.listIncomplete()) {
            if (run.conversationId === conversationId && run.status === 'queued')
              await runLifecycleService.finalize({ runId: run.id, status: 'cancelled', errorCode: 'RUN_CANCELLED', completedAt: new Date().toISOString() })
          }
        },
        sessions: { invalidateConversation: id => sessions.invalidateConversationWithResult(id) },
        onObserverError: () => record({ event: 'task.deletion_observer_failed', level: 'warn' }),
      })
      const notification = service.onDidCommit((event) => {
        const conversation = conversations.findById(event.conversationId)
        if (conversation)
          options.rpc.notify(CONVERSATION_CHANGED, conversation)
      })
      const deletionDiagnostic = service.onDidCommit((event) => {
        if (event.tombstoned)
          record({ event: 'task.tombstone.committed', level: 'info', conversationId: event.conversationId, operationId: event.commitId })
        if (event.revokedGrantIds.length)
          record({ event: 'task.grants.revoked', level: 'info', conversationId: event.conversationId, operationId: event.commitId, count: event.revokedGrantIds.length })
      })
      const cleanupDiagnostic = service.onDidCleanup(event => record({ event: `task.cleanup.${event.status}`, level: event.status === 'failed' ? 'warn' : 'info', conversationId: event.conversationId, operationId: event.operationId, ...(event.errorCode ? { errorCode: event.errorCode } : {}) }))
      defer(async () => {
        await service.dispose()
        notification.dispose()
        deletionDiagnostic.dispose()
        cleanupDiagnostic.dispose()
      })
      return service
    })
    const extensionActions = await host.start('runtime.plugin_actions', ({ defer }) => {
      const service = new ExtensionActionService({
        runtime: extensionAgent,
        repository: createExtensionInvocationRepository(options.database),
        capture: (conversationId, source) => extensionTaskContext.captureAction(conversationId, source),
        onObserverError: () => record({ event: 'plugins.action.observer_failed', level: 'warn' }),
      })
      const binding = bindExtensionActions(service, { turns: turnRequests, execution: runner, metadata: conversationMetadata, deletions: conversationLifecycle, runs })
      const diagnostics = service.onDidFail(event => record({ event: 'plugins.action.failed', level: 'warn', ...event }))
      const notification = service.onDidChange(event => options.rpc.notify(conversationTimelineChanged.method, event))
      const list = registerRuntimeRequest(options.rpc, extensionActionRpc.list, (_input, signal) => service.list(signal))
      const invoke = registerRuntimeRequest(options.rpc, extensionActionRpc.invoke, (input, signal) => service.invoke(input, signal))
      defer(async () => {
        binding.dispose()
        list()
        invoke()
        await service.dispose()
        diagnostics.dispose()
        notification.dispose()
      })
      return service
    }, ['runtime.plugins', 'runtime.task_metadata', 'runtime.usage'])
    taskAttention.start(conversationLifecycle, runLifecycleService)
    const automationOccurrenceLifecycle = await host.start('runtime.automation_deletion', ({ defer }) => {
      const service = new AutomationOccurrenceLifecycleService({
        automations: automationService,
        conversationLifecycle,
        notifications: notificationService,
        onObserverError: () => record({ event: 'automation.deletion_observer_failed', level: 'warn' }),
      })
      const diagnostics = service.onDidCleanup(event => record({ event: `automation.cleanup.${event.status}`, level: event.status === 'failed' ? 'warn' : 'info', automationId: event.automationId, occurrenceId: event.occurrenceId, operationId: event.operationId, errorCode: event.errorCode }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const executionPlanner = new BuddyRunExecutionPlanner({
      attachments: attachmentService,
      commands: commandRequests,
      conversations,
      models: executionModels,
      runInputs,
      runs,
      sessions: sessionBlueprints,
      skills: skillService,
    })
    const turnLauncher = new BuddyTurnLauncher({
      lifecycle: runLifecycleService,
      planner: executionPlanner,
      runner,
    })
    const chatCommandService = await host.start('runtime.chat_commands', ({ defer }) => {
      const service = new ChatCommandService({
        commands: commandRequests,
        conversationLifecycle,
        conversations,
        drafts: composerDrafts,
        spaces: spacesRepository,
        runs,
        turnLauncher,
        onObserverError: () => record({ event: 'observer.failed', component: 'runtime.chat_commands', level: 'warn' }),
      })
      const diagnostics = service.onDidCommit((event) => {
        for (const fact of event.facts) {
          record({
            event: fact.kind,
            level: 'info',
            operationId: event.commitId,
            requestId: event.requestId,
            conversationId: event.conversationId,
            branchId: event.branchId,
            ...(fact.kind === 'run.queued' ? { runId: fact.runId } : {}),
            ...(fact.kind === 'draft.consumed' ? { revision: fact.committedRevision } : {}),
          })
        }
      })
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const composerDraftService = await host.start('runtime.composer_drafts', ({ defer }) => {
      const service = new ComposerDraftService(composerDrafts, draftId => composerResourceService.discard(draftId), () => record({ event: 'observer.failed', component: 'runtime.composer_drafts', level: 'warn' }))
      const committed = service.onDidCommit(event => record({ event: `draft.${event.kind}`, level: 'info', operationId: event.operationId, revision: event.revision }))
      const cleanup = service.onDidCleanup(event => record({ event: `draft.cleanup.${event.status}`, level: event.status === 'failed' ? 'warn' : 'info', operationId: event.operationId, ...(event.errorCode ? { errorCode: event.errorCode } : {}) }))
      defer(async () => {
        await service.dispose()
        committed.dispose()
        cleanup.dispose()
      })
      return service
    })
    const chatTurnService = await host.start('runtime.chat_turns', ({ defer }) => {
      const service = new ChatTurnService({
        inputValidation: new ChatInputValidationService({
          attachments: attachmentService,
          models: executionModels,
          paths,
          recovery: sessionRecovery,
          runInputs,
          runs,
          sessions,
          tree: conversationTree,
        }),
        composerResources: composerResourceService,
        drafts: composerDrafts,
        attachments: attachmentService,
        conversationLifecycle,
        conversations,
        spaces: spacesRepository,
        providers: providerService,
        runInputs,
        runner,
        runs,
        skills: skillService,
        turnLauncher,
        turnRequests,
      })
      defer(() => service.dispose())
      return service
    })
    chatQueueService = await host.start('runtime.chat-queue', async ({ defer }) => {
      const service = new ChatQueueService({ queue: createChatQueueRepository(options.database), turns: chatTurnService, requests: turnRequests, launcher: turnLauncher, runner, runs, runInputs, eventLog: options.eventLog, onObserverError: () => record({ event: 'queue.observer_failed', level: 'error' }) })
      const actionInputs = service.onDidChange((event) => {
        if (event.committed?.messageId && event.committed.runId)
          extensionActions.dispatch({ type: 'task:input:committed', data: { conversationId: event.scope.conversationId, branchId: event.scope.branchId, runId: event.committed.runId, messageId: event.committed.messageId, commitId: event.committed.commitId } })
      })
      const continuation = new QueueContinuation({ queue: service, runner, runs, eventLog: options.eventLog, record })
      const diagnostics = service.onDidChange((event) => {
        const committed = event.committed
        if (!committed)
          return
        record({ event: `queue.${event.kind}`, level: 'info', operationId: committed.commitId, conversationId: event.scope.conversationId, branchId: event.scope.branchId, ...(committed.runId ? { runId: committed.runId } : {}) })
        if (committed.draftReceipt)
          record({ event: 'draft.consumed', level: 'info', operationId: committed.commitId, revision: committed.draftReceipt.committedRevision })
        if (committed.messageId)
          record({ event: 'message.created', level: 'info', operationId: committed.commitId, conversationId: event.scope.conversationId, ...(committed.runId ? { runId: committed.runId } : {}) })
        if (committed.attachmentOwnership)
          record({ event: `attachments.${committed.attachmentOwnership.kind}_bound`, level: 'info', operationId: committed.commitId, conversationId: event.scope.conversationId, count: committed.attachmentOwnership.attachmentIds.length, ...(committed.runId ? { runId: committed.runId } : {}) })
      })
      defer(async () => {
        actionInputs.dispose()
        const stopped = continuation.dispose()
        service.dispose()
        await stopped
        await service.drain()
        diagnostics.dispose()
      })
      await continuation.start()
      return service
    })
    const runtime: BuddyRuntime = {
      startTurn: input => chatTurnService.start(input),
    }
    const contextUsageService = new ContextUsageSnapshotService({
      getRuntimePreferences: async () => {
        return runtimePreferencesSchema.parse(await options.rpc.request(runtimePreferencesRpc.get, {}))
      },
      drafts: composerDrafts,
      tree: conversationTree,
      agentDirectory,
      blueprints: sessionBlueprints,
      conversations,
      models: executionModels,
      paths,
      runs,
      sessionExtensionServices,
    })
    const dispatcher = await host.start('runtime.automation_dispatcher', ({ defer }) => {
      const service = new AutomationDispatcher(automationService, new AgentTaskAutomationAction({
        automationService,
        cancelRun: (runId, errorCode) => runner.cancel(runId, errorCode),
        clock: automationClock,
        launchTurn: (runId, signal) => turnLauncher.launch(runId, signal),
        resolveModel: target => resolveAutomationModelSelection({
          defaults: providerService,
          models: executionModels,
        }, target),
        resolveSpace: async (spaceId, executionContext) => {
          const space = spacesRepository.findById(spaceId)
          if (!space || space.revokedAt !== null)
            return null
          if (!matchesSpaceExecutionContext(space, executionContext))
            return { status: 'context_changed' }
          return { executionContext, id: space.id, status: 'ready' }
        },
        turns: automationTurns,
      }), () => record({ event: 'automation.dispatch_observer_failed', level: 'warn' }))
      const diagnostics = service.onDidChange(event => record({
        event: `automation.dispatch.${event.kind}`,
        level: event.kind === 'failed' ? 'warn' : 'info',
        ...('occurrenceId' in event ? { occurrenceId: event.occurrenceId, automationId: event.automationId } : { count: event.count }),
      }))
      defer(async () => {
        try {
          await stopExecution()
        }
        finally {
          diagnostics.dispose()
        }
      })
      return service
    })
    automationDispatcher = dispatcher
    const scheduler = new AutomationScheduler({
      automationService,
      clock: automationClock,
      dispatch: occurrence => dispatcher.dispatch(occurrence),
      onObserverError: () => record({ event: 'automation.scheduler_observer_failed', level: 'warn' }),
    })
    automationScheduler = scheduler

    await host.step('runtime.recovery', async () => {
      await automationOccurrenceLifecycle.recoverPendingDeletions()
      await conversationLifecycle.recoverPendingDeletions()
      const count = await runRecoveryService.recoverInterruptedRuns()
      record({ event: 'runtime.runs_recovered', level: 'info', count })
      await options.eventLog.compactTerminalRuns()
    })

    await host.start('runtime.rpc', ({ defer }) => {
      const register = (dispose: () => void) => defer(dispose)
      register(registerExtensionConditionRpc({ rpc: options.rpc, tasks: conversations, history: extensionHistory, runs, inputs: runInputs, providers: providerService }))
      register(
        registerWebSettingsRpc(options.rpc, webSettings),
      )
      register(
        registerNotificationRpc({
          rpc: options.rpc,
          service: notificationService,
        }),
      )
      register(
        registerWorkspaceStateRpc({
          service: workspaceStateService,
          rpc: options.rpc,
        }),
      )
      register(
        registerArtifactRpc({
          rpc: options.rpc,
          service: artifactService,
        }),
      )
      register(
        registerChangeRpc({
          conversations,
          runs,
          rpc: options.rpc,
          service: changeCaptureService,
        }),
      )
      register(
        registerRunRpc({
          isBusy: () => runner.hasActiveExecutions || runs.hasIncomplete() || approvalsRepository.list({ status: 'pending', limit: 1 }).length > 0,
          getCacheWarmingStatus: (conversationId) => {
            const branchId = conversations.findById(conversationId)?.activeBranchId
            return branchId ? sessions.getReady(conversationId, branchId)?.getCacheWarmingStatus?.() ?? null : null
          },
          eventLog: options.eventLog,
          inputs: runInputs,
          repository: runs,
          rpc: options.rpc,
          usage: usageRepository,
        }),
      )
      register(registerContextPanelRpc({ rpc: options.rpc, runs, events: options.eventLog }))
      register(
        registerAttachmentRpc({
          rpc: options.rpc,
          service: attachmentService,
        }),
      )
      register(
        registerComposerResourceRpc({
          drafts: composerDraftService,
          rpc: options.rpc,
          service: composerResourceService,
        }),
      )
      register(
        registerComposerDraftRpc({
          rpc: options.rpc,
          service: composerDraftService,
        }),
      )
      register(
        registerUsageRpc({
          analytics: createUsageAnalyticsRepository(options.database),
          repository: usageRepository,
          rpc: options.rpc,
        }),
      )
      register(
        registerChatRpc({
          drafts: composerDraftService,
          commands: chatCommandService,
          rpc: options.rpc,
          runtime,
          turns: chatTurnService,
          queue: chatQueueService,
        }),
      )
      register(
        registerContextRpc({
          rpc: options.rpc,
          service: contextUsageService,
        }),
      )
      register(registerTaskMarkRpc(options.rpc, taskMarks, taskAttention))
      register(registerConversationTreeRpc({
        database: options.database,
        conversations,
        rpc: options.rpc,
        artifacts: artifactsRepository,
        attachments: attachmentService,
        changes: changeCaptureService,
        eventLog: options.eventLog,
        runInputs,
        runs,
      }))
      register(
        registerConversationRpc({
          artifacts: artifactsRepository,
          attachments: attachmentService,
          changes: changeCaptureService,
          conversations,
          metadata: conversationMetadata,
          deleteConversation: async (conversationId) => {
            const result = await automationOccurrenceLifecycle.deleteConversation(conversationId)
            return result.deleted
          },
          eventLog: options.eventLog,
          isDeleting: conversationId => conversationLifecycle.isDeleting(conversationId),
          rpc: options.rpc,
          runInputs,
          runs,
        }),
      )
      register(
        registerApprovalRpc({
          repository: approvalsRepository,
          rpc: options.rpc,
          service: approvalService,
        }),
      )
      register(
        registerAutomationRpc({
          approvals: approvalsRepository,
          changes: automationChanges,
          clock: automationClock,
          lifecycle: automationOccurrenceLifecycle,
          rpc: options.rpc,
          runs,
          service: automationService,
        }),
      )
      register(
        registerMcpConnectorRpc(options.rpc, connectorService),
      )
      register(
        registerSpaceRpc({
          rpc: options.rpc,
          service: spaceService,
        }),
      )
      register(registerSpaceFileRpc(options.rpc, spaceFiles))
      register(
        registerProviderRpc({
          rpc: options.rpc,
          service: providerService,
        }),
      )
      register(
        registerSkillServiceRpc(options.rpc, skillService),
      )
    })
    await host.start('runtime.scheduler', ({ defer }) => {
      const diagnostics = scheduler.onDidChange(event => record({ event: `automation.scheduler.${event.state}`, level: event.state === 'degraded' ? 'warn' : 'info', count: event.activeCount, errorCode: event.errorCode }))
      defer(async () => {
        try {
          await stopExecution()
        }
        finally {
          diagnostics.dispose()
        }
      })
      return scheduler.start()
    }, ['runtime.rpc', 'runtime.execution'])
    return { dispose: () => host.stop().finally(stopLifecycleDiagnostics), runtime }
  }
  catch (error) {
    try {
      await host.stop()
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime initialization and cleanup failed')
    }
    finally {
      stopLifecycleDiagnostics()
    }
    throw error
  }
}

function requireValue<T>(value: T | null, code: BuddyServiceErrorCode): T {
  if (value === null)
    throw new BuddyServiceError(code)
  return value
}
