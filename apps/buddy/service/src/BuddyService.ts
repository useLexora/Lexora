import type { DatabaseSync } from 'node:sqlite'
import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import type { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import type { BuddyExecutionProfile } from '../../shared/permissions/executionProfile'
import type { BuddySessionExtensionServices } from './agent/extensions/createBuddySessionExtensions'
import type { ReusableBuddySession } from './agent/sessions/ReusableBuddySession'
import type { AutomationClock } from './automations/AutomationScheduleEvaluator'
import type { BuddyRuntime } from './BuddyRuntime'
import type { TrustedCommandPrincipal } from './commands/CommandAdmissionService'
import type { RunEventLogPort } from './events/RunEventPorts'
import type { RuntimePlatform } from './platform/RuntimePlatform'
import type { ProductActorCommands as BuddyServiceCommands } from './productProtocol/ProductActorCommandScope'
import type { ProductConnectionOptions } from './productProtocol/ProductConnection'
import type { BuddyServiceErrorCode, RuntimeRequestRegistrar } from './rpc/runtimeRequest'
import type { ServiceClientPeer, ServiceClientRole } from './rpc/ServiceClientConnections'
import type { ConversationRecord } from './storage/conversationRecord'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { currentPlatform } from '../../platform/currentPlatform'
import { artifactsChanged } from '../../shared/artifacts/artifactApi'
import { automationNotifications } from '../../shared/automation/automationApi'
import { buddiesChanged } from '../../shared/buddies/buddyApi'
import { changesChanged } from '../../shared/changes/changeApi'
import { connectorNotifications } from '../../shared/connectors/connectorApi'
import { buddyUserMessageContentV1Schema, getBuddyUserContentActorReferences } from '../../shared/conversation/buddyUserContent'

import { composerResourcesChanged } from '../../shared/conversation/composerApi'
import { CONVERSATION_CHANGED, conversationTimelineChanged } from '../../shared/conversation/conversationApi'
import { Emitter } from '../../shared/events/Emitter'

import { executionsChanged } from '../../shared/executions/executionPresentationApi'
import { extensionActionRpc } from '../../shared/extensions/extensionActionApi'
import { imageRpc } from '../../shared/images/imagePreferences'
import { ServiceHost } from '../../shared/lifecycle/ServiceHost'
import { ServiceLifecycleSource } from '../../shared/lifecycle/ServiceLifecycleSource'
import { webSettingsChanged } from '../../shared/network/webApi'
import { notificationsChanged } from '../../shared/notifications/notificationApi'
import { ApplicationEvents as EventPublisher } from '../../shared/observability/ApplicationEvents'
import { observeLifecycleDiagnostics } from '../../shared/observability/lifecycleDiagnostics'
import { resourcePrepareSchema } from '../../shared/privateNetwork/resources'
import { ProductProtocolError } from '../../shared/productProtocol/errors'
import { desktopProductContentProject } from '../../shared/productProtocol/transport'
import { promptsRpc } from '../../shared/prompts/promptApi'
import { userQuestionsChanged } from '../../shared/questions/userQuestionApi'
import { toPublicRunEvent } from '../../shared/runs/publicRunEvent'
import { runNotifications } from '../../shared/runs/runApi'
import { taskMetricsChanged } from '../../shared/runs/taskMetricsApi'
import { spaceChanged } from '../../shared/spaces/spaceApi'
import { spaceFilesChanged } from '../../shared/spaces/spaceFileApi'
import { PiEventBridge } from './agent/events/PiEventBridge'
import { BuddyAgentRunner } from './agent/execution/BuddyAgentRunner'
import { BuddyRunExecutionPlanner } from './agent/execution/BuddyRunExecutionPlanner'
import { BuddyTurnLauncher } from './agent/execution/BuddyTurnLauncher'
import { CodemodeWorkerPool } from './agent/execution/CodemodeWorkerPool'
import { ExecutionComposerInputService } from './agent/execution/ExecutionComposerInputService'
import { ExecutionCoordinator } from './agent/execution/ExecutionCoordinator'
import { ExecutionDelegationService } from './agent/execution/ExecutionDelegationService'
import { ExecutionPresentationService } from './agent/execution/ExecutionPresentationService'
import { PiTurnExecutor } from './agent/execution/PiTurnExecutor'
import { readExecutionResult } from './agent/execution/readExecutionResult'
import { registerExecutionRpc } from './agent/execution/registerExecutionRpc'
import { RuntimeExecutionLifecycle } from './agent/execution/RuntimeExecutionLifecycle'
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
import { BuddiesService } from './buddies/BuddiesService'
import { BuddyDefinitionResolver } from './buddies/BuddyDefinitionResolver'
import { readBuddyToolOptions } from './buddies/readBuddyToolOptions'
import { registerBuddiesRpc } from './buddies/registerBuddiesRpc'
import { ChangeCaptureService } from './changes/ChangeCaptureService'
import { createChangeSetRepository } from './changes/changeSetRepository'
import { MutationCoordinator } from './changes/MutationCoordinator'
import { createMutationEvidenceRepository } from './changes/mutationEvidenceRepository'
import { MutationRecoveryService } from './changes/MutationRecoveryService'
import { createMutationRepository } from './changes/mutationRepository'
import { registerChangeRpc } from './changes/registerChangeRpc'
import { isReviewUserMessage } from './chat/buddyReviewPrompt'
import { ChatCommandService } from './chat/ChatCommandService'
import { ChatInputValidationService } from './chat/ChatInputValidationService'
import { ChatQueueService } from './chat/ChatQueueService'
import { ChatTurnService } from './chat/ChatTurnService'
import { ComposerDraftService } from './chat/ComposerDraftService'
import { QueueContinuation } from './chat/QueueContinuation'
import { registerChatRpc } from './chat/registerChatRpc'
import { registerComposerDraftRpc } from './chat/registerComposerDraftRpc'
import { TurnRequestService } from './chat/TurnRequestService'
import { createLocalCommandPrincipal } from './commands/CommandAdmissionService'
import {
  McpConnectorService,
} from './connectors/mcp/McpConnectorService'
import { McpSessionResourceConsumer } from './connectors/mcp/McpSessionResourceConsumer'
import { observeMcpDiagnostics, observeMcpNotifications } from './connectors/mcp/observeMcpEvents'
import { registerMcpConnectorRpc } from './connectors/mcp/registerMcpConnectorRpc'
import { registerContextPanelRpc } from './context-panel/registerContextPanelRpc'
import { ContextUsageSnapshotService } from './context/ContextUsageSnapshotService'
import { registerContextRpc } from './context/registerContextRpc'
import { ConversationArchiveService } from './conversations/ConversationArchiveService'
import { ConversationCleanupService } from './conversations/ConversationCleanupService'
import { ConversationLifecycleService } from './conversations/ConversationLifecycleService'
import { ConversationMetadataService } from './conversations/ConversationMetadataService'
import { ConversationMutationGuard } from './conversations/ConversationMutationGuard'
import { ConversationPurgeService } from './conversations/ConversationPurgeService'
import { createExtensionReferenceCapabilities } from './conversations/extensionReferenceCapabilities'
import { createExtensionTaskCapabilities } from './conversations/extensionTaskCapabilities'
import { ExtensionTaskContext } from './conversations/ExtensionTaskContext'
import { registerConversationArchiveRpc } from './conversations/registerConversationArchiveRpc'
import { registerConversationCleanupRpc } from './conversations/registerConversationCleanupRpc'
import { registerConversationRpc } from './conversations/registerConversationRpc'
import { registerConversationTreeRpc } from './conversations/registerConversationTreeRpc'
import { registerTaskMarkRpc } from './conversations/registerTaskMarkRpc'
import { TaskAttentionProjection } from './conversations/TaskAttentionProjection'
import { TaskMarkService } from './conversations/TaskMarkService'
import { createBuddyCapabilityFactory } from './createBuddyCapabilityFactory'
import { DirectoryGrantService } from './directories/DirectoryGrantService'
import { observeRunDiagnostics } from './events/observeRunDiagnostics'
import { RunEventCorruptionError } from './events/RunEventFailure'
import { RunEventLog } from './events/RunEventLog'
import { SqliteRunEventLog } from './events/SqliteRunEventLog'
import { FileResourceCoordinator } from './files/FileResourceCoordinator'
import { LocalDocumentFileService, registerLocalDocumentRpc } from './files/LocalDocumentFileService'
import { NativeFileEngine } from './files/NativeFileEngine'
import { registerTaskFileRpc } from './files/registerTaskFileRpc'
import { TaskFileAccess } from './files/TaskFileAccess'
import { TaskFileService } from './files/TaskFileService'
import { observeImageDiagnostics } from './images/ImageOperationLifecycle'
import { ImageRequestStore } from './images/ImageRequestStore'
import { ImageTransformService } from './images/ImageTransformService'
import { OpenAiImageGenerationService } from './images/OpenAiImageGenerationService'
import { RoutedImageGateway } from './images/RoutedImageGateway'
import { AttentionNotificationService } from './notifications/AttentionNotificationService'
import { NotificationProjection } from './notifications/NotificationProjection'
import { registerNotificationRpc } from './notifications/registerNotificationRpc'
import { observePetActionDiagnostics } from './pet/observePetActionDiagnostics'
import { PetActionService } from './pet/PetActionService'
import { RuntimePlatformLifecycle } from './platform/RuntimePlatformLifecycle'
import { bindExtensionActions } from './plugins/bindExtensionActions'
import { ExtensionActionService } from './plugins/ExtensionActionService'
import { ExtensionAgentRuntime } from './plugins/ExtensionAgentRuntime'
import { ExtensionCapabilitySync } from './plugins/ExtensionCapabilitySync'
import { observeExtensionAgentDiagnostics } from './plugins/observeExtensionAgentDiagnostics'
import { PluginAuthoringService } from './plugins/PluginAuthoringService'
import { PrivateNetworkController } from './privateNetwork/PrivateNetworkController'
import { RemoteAvatarService } from './privateNetwork/RemoteAvatarService'
import { RemoteResourceService } from './privateNetwork/RemoteResourceService'
import { RemoteUploadService } from './privateNetwork/RemoteUploadService'
import { createProductCommandHandlers } from './productProtocol/createProductCommandHandlers'
import { createProductModelQueries } from './productProtocol/createProductModelQueries'
import { createProductSynchronization } from './productProtocol/createProductSynchronization'
import { ProductActorCommandScope } from './productProtocol/ProductActorCommandScope'
import { ProductConnection } from './productProtocol/ProductConnection'
import { ProductContentReferences } from './productProtocol/ProductContentReferences'
import { ProductQueries } from './productProtocol/ProductQueries'
import { registerLocalProductConnection } from './productProtocol/registerLocalProductConnection'
import { getBuiltinPromptCatalog } from './prompts/builtinPromptCatalog'
import { createProviderService } from './providers/createProviderService'
import { createExtensionModelCapabilities } from './providers/extensionModelCapabilities'
import { ProviderDependents } from './providers/ProviderDependents'
import { registerProviderCatalogRpc, registerProviderRpc } from './providers/registerProviderRpc'
import { resolveInteractiveModelSelection } from './providers/resolveInteractiveModelSelection'
import { registerUserQuestionRpc } from './questions/registerUserQuestionRpc'
import { UserQuestionDelivery } from './questions/UserQuestionDelivery'
import { UserQuestionService } from './questions/UserQuestionService'
import { candidateLegacyRegistrar, ProductCommandRequiredError } from './rpc/candidateLegacyRegistrar'
import { BuddyServiceError, registerRuntimeRequest } from './rpc/runtimeRequest'
import { ServiceClientConnections } from './rpc/ServiceClientConnections'
import { ConversationStatusService } from './runs/ConversationStatusService'
import { registerRunRpc } from './runs/registerRunRpc'
import { RunContinuityService } from './runs/RunContinuityService'
import { RunLifecycleService } from './runs/RunLifecycleService'
import { RunRecoveryService } from './runs/RunRecoveryService'
import { observeSandboxClient } from './sandbox/observeSandboxClient'
import { observeSkillDiagnostics, observeSkillNotifications } from './skills/observeSkillEvents'
import {
  registerSkillCatalogRpc,
  registerSkillServiceRpc,
  SkillService,
} from './skills/SkillService'
import { registerSpaceFileRpc } from './spaces/registerSpaceFileRpc'
import { registerSpaceQueries, registerSpaceRpc } from './spaces/registerSpaceRpc'
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
import { createBuddyRepository } from './storage/buddyRepository'
import { ChatControlCommandRepository } from './storage/ChatControlCommandRepository'
import { createChatQueueRepository } from './storage/chatQueueRepository'
import { createCommandRequestRepository } from './storage/commandRequestRepository'
import { createComposerDraftRepository, findPersonalComposerDraft } from './storage/composerDraftRepository'
import { createComposerResourceRepository } from './storage/composerResourceRepository'
import { createConnectorRepository } from './storage/connectorRepository'
import { createConversationArchiveRepository } from './storage/conversationArchiveRepository'
import { createConversationDeletionRepository } from './storage/conversationDeletionRepository'
import { createConversationDirectoryGrantRepository } from './storage/conversationDirectoryGrantRepository'
import { createConversationHistoryStore } from './storage/conversationHistoryRepository'
import { createConversationMemberRepository } from './storage/conversationMemberRepository'
import { createConversationRepository } from './storage/conversationRepository'
import { createConversationStatisticsRepository } from './storage/conversationStatisticsRepository'
import { createConversationTreeRepository } from './storage/conversationTreeRepository'
import { createExecutionRepository } from './storage/executionRepository'
import { createExtensionInvocationRepository } from './storage/extensionInvocationRepository'
import { createExtensionReferenceRepository } from './storage/extensionReferenceRepository'
import { createExtensionTaskContextRepository } from './storage/extensionTaskContextRepository'
import { createMailboxRepository } from './storage/mailboxRepository'
import { createManagedCapabilityRepository } from './storage/managedCapabilityRepository'
import { createNotificationAttentionRepository } from './storage/notificationAttentionRepository'
import { createProviderRepository } from './storage/providerRepository'
import { createRunInputRepository } from './storage/runInputRepository'
import { createRunRepository } from './storage/runRepository'
import { createSessionReferenceRepository } from './storage/sessionReferenceRepository'
import { createSkillRepository } from './storage/skillRepository'
import { createSpaceRepository } from './storage/spaceRepository'
import { requireSqliteAuthority } from './storage/sqliteAuthority'
import { guardStorageDatabase } from './storage/StorageIsolation'
import { createTaskMarkRepository } from './storage/taskMarkRepository'
import { createThreadBindingRepository } from './storage/threadBindingRepository'
import { afterTransactionCommit, withTransaction } from './storage/transaction'
import { createUsageAnalyticsRepository } from './storage/usageAnalyticsRepository'
import { createUsageRepository } from './storage/usageRepository'
import { createWorkspaceRepository } from './storage/workspaceRepository'
import { registerUsageRpc } from './usage/registerUsageRpc'
import { UsageService } from './usage/UsageService'
import { observeWebDiagnostics, observeWebHostDiagnostics } from './web/observeWebDiagnostics'
import { WebCapabilityService } from './web/WebCapabilityService'
import { registerWebSettingsRpc, WebSettingsService } from './web/WebSettingsService'
import { normalizeComposerWorkspace } from './workspace/normalizeComposerWorkspace'
import { registerWorkspaceStateRpc } from './workspace/registerWorkspaceStateRpc'
import { WorkspaceStateService } from './workspace/WorkspaceStateService'

export interface StartBuddyServiceOptions {
  serviceInstanceId?: string
  productIdentity?: { serviceId: string, profileId: string }
  record?: ApplicationDiagnosticReporter
  events?: ApplicationEvents
  lifecycle?: ServiceLifecycleSource
  automationClock?: AutomationClock
  buddyHome: string
  builtinSkillsDirectories?: readonly string[]
  database: DatabaseSync
  platform: RuntimePlatform
  eventLog: RunEventLogPort
}

export type { ProductActorCommands as BuddyServiceCommands } from './productProtocol/ProductActorCommandScope'

export interface BuddyServiceHandle {
  suspendPlatform: (reason?: string) => Promise<void>
  resumePlatform: () => Promise<void>
  assertPlatformAvailable: () => void

  createLocalProductConnection: (options: Pick<ProductConnectionOptions, 'assertCurrent' | 'send' | 'close'> & { connectionId: string }) => ProductConnection
  createProductConnection: (options: Pick<ProductConnectionOptions, 'context' | 'assertCurrent' | 'send' | 'close'> & { allowLocalEffects?: boolean, trustedPrincipal?: TrustedCommandPrincipal }) => ProductConnection
  commands: BuddyServiceCommands | null
  connectClient: (role: ServiceClientRole, peer: ServiceClientPeer) => () => void
  startMaintenance: () => void
  dispose: () => Promise<void>
  prepareIdleShutdown: () => boolean
  runtime: BuddyRuntime
}

export async function startBuddyService(
  options: StartBuddyServiceOptions,
): Promise<BuddyServiceHandle> {
  if (options.database.prepare('SELECT 1 FROM sqlite_schema WHERE type = \'table\' AND name = \'storage_profile\'').get()) {
    requireSqliteAuthority(options.database)
    if (!options.productIdentity)
      throw new ProductProtocolError('SERVICE_NOT_READY')
    if (!(options.eventLog instanceof SqliteRunEventLog))
      throw new Error('SQLite authority requires its event owner')
  }
  const events = options.events ?? new EventPublisher()
  if (options.record)
    events.subscribe(options.record)
  const record = events.publish
  const host = new ServiceHost(options.lifecycle ?? new ServiceLifecycleSource(() => record({ event: 'observer.failed', component: 'runtime.lifecycle', level: 'warn' })))
  const stopLifecycleDiagnostics = options.lifecycle ? () => {} : observeLifecycleDiagnostics(host.lifecycle, events)
  const storage = guardStorageDatabase(options.database)
  const clients = new ServiceClientConnections(storage.assertAvailable)
  let stopExecution: () => Promise<void> = async () => {}
  const notify = (method: string, params: unknown) => clients.notify('product', method, params)
  try {
    await host.start('runtime.clients', ({ defer }) => {
      const isolation = storage.onDidIsolate(() => {
        clients.stopAccepting()
        void stopExecution().catch(() => record({ event: 'execution.cleanup_failed', level: 'error' }))
      })
      const delivery = options.eventLog.onDidCommit(event => notify(runNotifications.event.method, toPublicRunEvent(event)))
      defer(() => {
        isolation.dispose()
        delivery.dispose()
        clients.dispose()
      })
    })
    const platformLifecycle = new RuntimePlatformLifecycle(record)
    const assertPlatformAvailable = () => platformLifecycle.assertAvailable()
    const paths = new BuddyDataPaths(options.buddyHome)
    const agentDirectory = join(options.buddyHome, 'agent')
    await host.step('runtime.filesystem', async () => {
      await Promise.all([
        mkdir(agentDirectory, { mode: 0o700, recursive: true }),
        mkdir(paths.conversationsDirectory, { mode: 0o700, recursive: true }),
        mkdir(paths.draftsDirectory, { mode: 0o700, recursive: true }),
      ])
    })

    const actorCommandScopes = new Map<string, ProductActorCommandScope>()
    const commandContext = options.eventLog instanceof SqliteRunEventLog
      ? await host.start('runtime.command_admission', ({ defer }) => {
          const sourceInstanceId = options.serviceInstanceId ?? randomUUID()
          const principal = createLocalCommandPrincipal(options.database)
          const identity = { ...requireSqliteAuthority(options.database), serviceInstanceId: sourceInstanceId }
          const scope = new ProductActorCommandScope(options.database, principal, identity)
          actorCommandScopes.set(principal.actorId, scope)
          const repository = new ChatControlCommandRepository(options.database, sourceInstanceId)
          defer(() => scope.dispose())
          return { admission: scope.admission, repository, principal, writer: (options.eventLog as SqliteRunEventLog).transactionWriter, identity }
        })
      : null
    const spacesRepository = createSpaceRepository(options.database)
    const conversations = createConversationRepository(options.database)
    const conversationHistory = createConversationHistoryStore(options.database)
    const runs = createRunRepository(options.database)
    const conversationMutations = new ConversationMutationGuard()
    const conversationAvailability = {
      assertConversationWritable: (id: string) => {
        commandContext?.repository.assertAccepting()
        conversationMutations.assertWritable(id)
        const conversation = conversations.findById(id)
        if (conversation?.archivedAt || conversation?.deletedAt)
          throw new BuddyServiceError('CONVERSATION_BUSY')
        options.eventLog.assertConversationWritable(id)
      },
      assertRunExecutable: (id: string) => {
        const run = runs.findById(id)
        if (run) {
          conversationMutations.assertWritable(run.conversationId)
          const conversation = conversations.findById(run.conversationId)
          if (conversation?.archivedAt || conversation?.deletedAt)
            throw new BuddyServiceError('CONVERSATION_BUSY')
        }
        options.eventLog.assertRunExecutable(id)
      },
    }
    const chatQueue = createChatQueueRepository(options.database)
    const executionRecords = createExecutionRepository(options.database)
    const threads = createThreadBindingRepository(options.database)
    const treeRepository = createConversationTreeRepository(options.database)
    await host.start('runtime.run_diagnostics', ({ defer }) => {
      const subscription = observeRunDiagnostics(options.eventLog, runs, record)
      defer(() => subscription.dispose())
    })
    const conversationDirectoryGrants = createConversationDirectoryGrantRepository(options.database)
    const taskMarkRepository = createTaskMarkRepository(options.database)
    const taskMarks = await host.start('runtime.task_marks', ({ defer }) => {
      const service = new TaskMarkService(taskMarkRepository, () => record({ event: 'observer.failed', component: 'runtime.task_marks', level: 'warn' }), commandContext ? options.database : undefined)
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
      const service = new TurnRequestService(options.database, () => record({ event: 'observer.failed', component: 'runtime.turn_requests', level: 'warn' }), conversationAvailability, commandContext?.writer)
      const notifications = service.onDidCommit((event) => {
        const conversation = conversations.findById(event.conversationId)
        if (conversation)
          notify(CONVERSATION_CHANGED, conversation)
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
    const managedCapabilities = createManagedCapabilityRepository(options.database)
    managedCapabilities.suspendAll()
    const buddies = await host.start('runtime.buddies', ({ defer }) => {
      const service = new BuddiesService(createBuddyRepository(options.database), () => record({ event: 'buddies.observer.failed', level: 'warn' }))
      const notices = service.onDidChange(event => notify(buddiesChanged.method, event))
      defer(() => {
        service.dispose()
        notices.dispose()
      })
      return service
    })
    const composerDrafts = createComposerDraftRepository(options.database)
    const personalDrafts = commandContext ? { findById: (id: string) => findPersonalComposerDraft(options.database, id) } : composerDrafts
    const commandRequests = createCommandRequestRepository(options.database)
    const connectorsRepository = createConnectorRepository(options.database)
    const spaceService = await host.start('runtime.spaces', ({ defer }) => {
      const service = new SpaceService(spacesRepository, () => record({ event: 'space.observer.failed', level: 'warn' }))
      const notices = service.onDidCommit(({ sourceId, revision, spaceId, kind }) => notify(spaceChanged.method, { sourceId, revision, spaceId, kind }))
      const diagnostics = service.onDidCommit(event => record({ event: `space.${event.kind.replaceAll('-', '_')}`, level: 'info', spaceId: event.spaceId, revision: event.revision, count: event.directories.length }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
        notices.dispose()
      })
      return service
    })
    const fileEngine = await host.start('runtime.file_engine', async ({ defer }) => {
      const engine = new NativeFileEngine(join(options.buddyHome, 'file-operations'))
      defer(() => engine.dispose())
      await engine.ready()
      return engine
    })
    const fileResources = new FileResourceCoordinator(fileEngine)
    const spaceFiles = await host.start('runtime.space_files', ({ defer }) => {
      const service = new SpaceFileService(spacesRepository, fileEngine)
      const notices = service.onDidChange(event => notify(spaceFilesChanged.method, event))
      const revoked = spaceService.onDidCommit(event => service.revoke(event.revokedDirectoryIds))
      defer(() => {
        notices.dispose()
        revoked.dispose()
      })
      const diagnostics = service.onDidChange(event => record({ event: `space.file.${event.kind.replaceAll('-', '_')}`, level: event.kind === 'response-denied' ? 'warn' : 'info', operationId: event.operationId, spaceId: event.spaceId, directoryId: event.directoryId, revision: event.revision }))
      defer(async () => {
        await service.dispose()
        diagnostics.dispose()
      })
      return service
    }, ['runtime.spaces', 'runtime.file_engine'])
    let runner!: BuddyAgentRunner
    let turnLauncher!: BuddyTurnLauncher
    let questions!: UserQuestionService
    let questionDelivery!: UserQuestionDelivery
    let delegation!: ExecutionDelegationService
    const approvalService = await host.start('runtime.approvals', ({ defer }) => {
      const service = new ApprovalService({
        commandAdmission: commandContext ? { database: options.database, admission: commandContext.admission, events: commandContext.writer } : undefined,
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
    const mutationEvidence = createMutationEvidenceRepository(options.database)
    const recoverySourceId = randomUUID()
    let recoveryRevision = 0
    const notifyRecovery = (runId: string) => {
      const run = runs.findById(runId)
      if (run)
        notify(changesChanged.method, { sourceId: recoverySourceId, revision: ++recoveryRevision, conversationId: run.conversationId, runId })
    }
    const mutations = await host.start('runtime.mutations', async ({ defer }) => {
      const service = new MutationCoordinator({ repository: createMutationRepository(options.database), evidence: mutationEvidence, resources: fileResources, getRunTitle: (runId) => {
        const run = runs.findById(runId)
        return run ? conversations.findById(run.conversationId)?.title ?? undefined : undefined
      } })
      const notices = service.onDidChange(event => notifyRecovery(event.runId))
      defer(() => notices.dispose())
      defer(() => service.dispose())
      await service.initialize()
      return service
    }, ['runtime.file_engine'])
    const mutationRecovery = await host.start('runtime.mutation_recovery', async ({ defer }) => {
      const service = new MutationRecoveryService({ mutations, record, evidence: mutationEvidence, receiptDirectory: join(options.buddyHome, 'process-receipts'), context: { conversations, runs }, onChange: notifyRecovery })
      defer(async () => {
        mutations.stopAdmission()
        await service.dispose()
      })
      await service.start()
      return service
    }, ['runtime.mutations'])
    const changeCaptureService = await host.start('runtime.change_capture', ({ defer }) => {
      const service = new ChangeCaptureService({ paths, repository: createChangeSetRepository(options.database), onListenerError: () => record({ event: 'observer.failed', component: 'runtime.change_capture', level: 'warn' }) })
      service.onDidChange(event => record({ event: `changes.${event.kind.replaceAll('-', '_')}`, level: event.errorCode ? 'warn' : 'info', producerInstanceId: event.sourceId, operationId: event.operationId, conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, revision: event.revision, count: event.count, errorCode: event.errorCode }))
      service.onDidChange((event) => {
        if (event.conversationId && !event.errorCode)
          notify(changesChanged.method, { sourceId: event.sourceId, revision: event.revision, conversationId: event.conversationId, runId: event.runId })
      })
      defer(() => service.dispose())
      return service
    })
    const runRecoveryService = new RunRecoveryService({
      cancelPendingApprovals: canRecoverRun => approvalService.cancelPendingApprovals('recovery', canRecoverRun),
      captureInterruptedChanges: async (runId) => {
        await changeCaptureService.markInterrupted(runId)
        const run = runs.findById(runId)
        const relevant = run?.parentRunId === null ? runs.listTree(run.rootRunId) : run ? [run] : []
        const degraded = relevant.some(item => mutations.getRunState(item.id).hazards.length > 0)
        executionRecords.recordCleanup(runId, degraded ? 'degraded' : 'clean', degraded ? 'EXECUTION_CLEANUP_DEGRADED' : null)
      },
      conversations,
      eventLog: options.eventLog,
      lifecycle: runLifecycleService,
      inspectCommittedCompaction: run => inspectCommittedPiCompaction({
        runId: run.id,
        threadId: run.threadId,
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
      const service = new AttachmentService({ paths, repository: createAttachmentRepository(options.database), assertConversationWritable: conversationAvailability.assertConversationWritable })
      service.onDidChange(event => record({ event: `attachment.${event.kind.replaceAll('-', '_')}`, level: event.kind === 'cleanup-failed' ? 'warn' : 'info', operationId: event.operationId, revision: event.revision, count: event.count }))
      defer(() => service.dispose())
      return service
    })
    const taskFileService = new TaskFileService(new TaskFileAccess({ conversations, conversationGrants: conversationDirectoryGrants, spaces: spacesRepository, paths }))
    const artifactsRepository = createArtifactRepository(options.database)
    const artifactService = await host.start('runtime.artifact_catalogue', ({ defer }) => {
      const service = new ArtifactService({ repository: artifactsRepository, onListenerError: () => record({ event: 'observer.failed', component: 'runtime.artifact_catalogue', level: 'warn' }) })
      service.onDidChange(event => record({ event: `artifact.${event.receipt.cause}.${event.kind.replaceAll('-', '_')}${event.kind === 'batch-settled' ? `.${event.receipt.outcome}.${event.receipt.stage}` : ''}`, level: event.errorCode ? 'warn' : 'info', producerInstanceId: event.sourceId, operationId: event.receipt.operationId, conversationId: event.receipt.conversationId, revision: event.revision, count: event.kind === 'file-written' ? event.receipt.written : event.receipt.artifactIds.length, errorCode: event.errorCode }))
      service.onDidChange((event) => {
        if (event.kind === 'catalogue-committed')
          notify(artifactsChanged.method, { sourceId: event.sourceId, revision: event.revision, conversationId: event.receipt.conversationId })
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
      const service = new ComposerResourceService({ artifacts: artifactService, attachments: attachmentService, conversationGrants: conversationDirectoryGrants, conversations, drafts: personalDrafts, publications: treeRepository, paths, repository: createComposerResourceRepository(options.database), spaces: spacesRepository })
      service.onDidChange(event => notify(composerResourcesChanged.method, { revision: event.revision, draftIds: [...new Set(event.resources.map(resource => resource.draftId))] }))
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
        platform: options.platform,
        notify,
        notifyManagement: (method, params) => clients.notify('management', method, params),
        providers: providersRepository,
        record,
      })
      defer(() => service.dispose())
      return service
    })
    const executionModels = providerService.executionModels
    const nativeImageGateway = new OpenAiImageGenerationService({
      modelRuntime: executionModels.getRuntime(),
      resolveCredentialMetadata: providerId => providerService.getCredentialMetadata(providerId),
      resolveSourceProviderId: providerId => executionModels.resolveSourceProviderId(providerId),
    })
    const pluginImages = await host.start('runtime.plugin_images', ({ defer }) => {
      const gateway = options.platform.createPluginImages()
      defer(() => gateway.dispose())
      return gateway
    })
    const pluginImageBackends = options.platform.createPluginImageBackends(providerService, pluginImages)
    const getImagePreferences = options.platform.imagePreferences
    const imageGenerationGateway = new RoutedImageGateway({
      native: nativeImageGateway,
      plugins: pluginImageBackends.generation,
      providers: providerService,
      preferences: getImagePreferences,
    })
    const imageReading = options.platform.createImageReading({ plugins: pluginImageBackends.reading, providers: providerService, usage: usageService, preferences: getImagePreferences })
    const sessions = await host.start('runtime.sessions', () => new BuddySessionRegistry<ReusableBuddySession>())
    const sessionReferences = createSessionReferenceRepository(options.database)
    const conversationMetadata = await host.start('runtime.task_metadata', ({ defer }) => {
      const service = new ConversationMetadataService({
        database: commandContext ? options.database : undefined,
        buddies,
        runInputs,
        runs,
        repository: conversations,
        spaces: spacesRepository,
        spaceMoves: {
          mutations: conversationMutations,
          hasPendingMessages: id => chatQueue.hasPending(id),
          hasActiveExecution: id => runner.hasActiveExecution(id) || runner.hasDegradedCleanup(id),
          validateTarget: validateSpaceMoveTarget,
        },
        sessions: {
          invalidateConversation: id => sessions.invalidateConversationWithResult(id),
          applyPermissionSettings: conversation => sessions.applyConversationPermissions(conversation.id, conversation),
          refreshModelSelection: id => sessions.refreshRunModel(id),
        },
        resolveModelSelection: selection => resolveInteractiveModelSelection(providerService, selection),
        onObserverError: () => record({ event: 'task.observer_failed', level: 'warn' }),
      })
      const notification = service.onDidCommit(event => notify(CONVERSATION_CHANGED, event.conversation))
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
    const extensionHistory = createExtensionTaskContextRepository(options.database, conversationHistory.lineage)
    const extensionReferences = createExtensionReferenceRepository(options.database, conversationHistory.lineage)
    const extensionTaskContext = new ExtensionTaskContext(conversations, extensionHistory, runs, runInputs, conversationAvailability.assertConversationWritable)
    const extensionAgent = await host.start('runtime.plugins', ({ defer }) => {
      const service = new ExtensionAgentRuntime({
        host: options.platform.plugins,
        createHandlers: (scope) => {
          const task = extensionTaskContext.open(scope)
          return {
            ...createExtensionTaskCapabilities(conversationMetadata, extensionHistory, task, scope),
            ...createExtensionReferenceCapabilities(extensionReferences, task, scope),
            ...options.platform.createExtensionResources(artifactService, task, scope),
            ...createExtensionModelCapabilities(executionModels, usageService, task),
          }
        },
        onObserverError: () => record({ event: 'plugins.observer_failed', level: 'warn' }),
      })
      const binding = service.bind()
      const releases = new Set<Promise<void>>()
      const terminal = options.eventLog.onDidCommit((event) => {
        if (!['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
          return
        const release = service.releaseRun(event.runId).catch(() => record({ event: 'plugins.run_release_failed', level: 'warn', runId: event.runId }))
        releases.add(release)
        void release.finally(() => releases.delete(release))
      })
      const diagnostics = observeExtensionAgentDiagnostics(service, record)
      defer(async () => {
        terminal.dispose()
        await Promise.all(releases)
        binding()
        try {
          await service.dispose()
        }
        finally {
          diagnostics.dispose()
        }
      })
      defer(options.platform.subscribeShellChanges(() => {
        void sessions.invalidateAll().catch(() => record({ event: 'shells.sessions_invalidation.failed', level: 'warn', errorCode: 'EXTENSION_INVALIDATION_FAILED' }))
      }))
      defer(options.platform.plugins.subscribe(() => {
        void sessions.invalidateMode('interactive').catch(() => record({ event: 'plugins.sessions_invalidation.failed', level: 'warn', errorCode: 'EXTENSION_INVALIDATION_FAILED' }))
      }))
      return service
    })
    const pluginModels = await host.start('runtime.plugin_models', ({ defer }) => {
      const registry = options.platform.createPluginModels(providerService, () => record({ event: 'plugins.models.refresh_failed', level: 'warn', errorCode: 'EXTENSION_INFERENCE_CATALOG_FAILED' }))
      defer(() => registry.dispose())
      void registry.refresh().catch(() => record({ event: 'plugins.models.refresh_failed', level: 'warn', errorCode: 'EXTENSION_INFERENCE_CATALOG_FAILED' }))
      return registry
    })
    const pluginBuilder = await host.start('runtime.plugin_authoring', ({ defer }) => {
      const service = new PluginAuthoringService(options.platform.authoring, () => record({ event: 'plugins.authoring.observer_failed', level: 'warn' }))
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
        managed: managedCapabilities,
        openExternal: options.platform.openExternal,
        onListenerError: () => record({ event: 'connectors.observer.failed', level: 'warn', errorCode: 'MCP_OBSERVER_FAILED' }),
        secrets: options.platform.connectorSecrets,
      })
      const diagnostics = observeMcpDiagnostics(service, record)
      const notifications = observeMcpNotifications(service, event => notify(connectorNotifications.changed.method, event))
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
      const pluginSkillsChanged = new Emitter<void>(() => record({ event: 'skills.plugins.observer_failed', level: 'warn', errorCode: 'SKILL_OBSERVER_FAILED' }))
      defer(() => pluginSkillsChanged.dispose())
      defer(options.platform.skills.subscribe(() => pluginSkillsChanged.fire()))
      const skillService = new SkillService({
        agentDirectory,
        builtinSkillsDirectories: options.builtinSkillsDirectories,
        spaces: spacesRepository,
        repository: createSkillRepository(options.database),
        paths,
        pluginSkills: {
          list: options.platform.skills.list,
          onDidChange: pluginSkillsChanged.event,
        },
        onListenerError: () => record({ event: 'skills.observer.failed', level: 'warn', errorCode: 'SKILL_OBSERVER_FAILED' }),
      })
      const sessionResources = new SessionResourceReconciler({
        skills: skillService,
        sessions,
        onListenerError: () => record({ event: 'sessions.resources.observer_failed', level: 'warn', errorCode: 'SESSION_RESOURCE_OBSERVER_FAILED' }),
      })
      const resourceDiagnostics = observeSessionResourceDiagnostics(sessionResources, record)
      const skillDiagnostics = observeSkillDiagnostics(skillService, record)
      const notifications = observeSkillNotifications(skillService, event => notify('skills.changed', event))
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
    await host.start('runtime.extension_capabilities', ({ defer }) => {
      const sync = new ExtensionCapabilitySync({
        buddies,
        connectors: connectorService,
        sources: managedCapabilities,
        descriptors: options.platform.capabilities.list,
        report: event => record(event),
      })
      const binding = options.platform.capabilities.bind({
        impact: extensionId => sync.impact(extensionId),
        apply: (descriptors, clearExtensionId, signal) => sync.apply(descriptors, clearExtensionId, signal),
      })
      const refreshAvailability = () => {
        void sync.refreshAvailability().catch(() => record({ event: 'extensions.capabilities.availability_failed', level: 'warn', errorCode: 'EXTENSION_CAPABILITY_FAILED' }))
      }
      const connectorChanges = connectorService.onDidChange(refreshAvailability)
      const connectionChanges = connectorService.onDidChangeConnection(refreshAvailability)
      defer(options.platform.capabilities.subscribe(() => {
        void sync.schedule()
      }))
      defer(async () => {
        binding()
        connectorChanges.dispose()
        connectionChanges.dispose()
        await sync.dispose()
      })
      void sync.schedule()
      return sync
    }, ['runtime.buddies', 'runtime.connectors'])
    const browserHost = options.platform.browser
    const webSettings = await host.start('runtime.web_settings', ({ defer }) => {
      const service = new WebSettingsService(workspace, options.platform.webSecrets)
      const notifications = service.onDidChange(change => notify(webSettingsChanged.method, { operationId: change.operationId, revision: change.revision }))
      const diagnostics = service.onDidChange(change => record({ event: `web.settings.${change.kind.replaceAll('-', '_')}`, level: change.kind === 'credential-failed' ? 'warn' : 'info', operationId: change.operationId, revision: change.revision }))
      defer(async () => {
        await service.dispose()
        notifications.dispose()
        diagnostics.dispose()
      })
      return service
    })
    const webHost = await host.start('runtime.web_host', ({ defer }) => {
      const client = options.platform.createWeb()
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
      const repository = createAutomationTurnRepository(options.database)
      const service = new AutomationTurnService({ bind: input => withTransaction(options.database, () => {
        commandContext?.repository.assertAccepting()
        const binding = repository.bind(input)
        if (commandContext && binding.kind === 'bound') {
          options.database.prepare('UPDATE runs SET next_event_sequence = 1 WHERE id = ? AND next_event_sequence IS NULL').run(binding.run.id)
          commandContext.writer.append({ runId: binding.run.id, type: 'run.queued', payload: { automationId: binding.occurrence.automationId, occurrenceId: binding.occurrence.id }, createdAt: input.boundAt })
        }
        return binding
      }) }, () => record({ event: 'automation.turn_observer_failed', level: 'warn' }))
      const notifications = service.onDidCommit((event) => {
        for (const fact of event.facts) {
          if (fact.kind !== 'task.created')
            continue
          const conversation = conversations.findById(fact.conversationId)
          if (conversation)
            notify(CONVERSATION_CHANGED, conversation)
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
      const changed = service.onDidCommit(event => notify(notificationsChanged.method, { revision: event.revision }))
      const diagnostics = service.onDidCommit(event => record({ event: `notifications.${event.reason}`, level: 'info', operationId: event.operationId, revision: event.revision, count: event.changes.length }))
      const projection = new NotificationProjection({ service, providers: providerService, automations: automationService, runs: options.eventLog, runRecords: runs, lifecycle: runLifecycleService, record })
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
    const automationChanges = await host.start('runtime.automation_changes', ({ defer }) => {
      const consumer = new AutomationChangeCoordinator({
        notify: automationId => notify(automationNotifications.changed.method, { automationId }),
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
      const service = new PetActionService({ eventSink: event => options.eventLog.append(event), executeSequence: options.platform.executePetSequence })
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
      codemodeWorkers: await host.start('runtime.codemode_workers', async ({ defer }) => {
        const pool = new CodemodeWorkerPool()
        defer(() => pool.dispose())
        const unsubscribe = await bindRuntimePreferences(options.platform.preferences, preferences => pool.configure(preferences))
        defer(unsubscribe)
        return pool
      }),
      shells: options.platform.shells,
      networkPermissions: options.platform.networkPermissions,
      imageReading,
      getImagePreferences,
      fileResources,
      questions: { ask: (...args) => questions.ask(...args), wait: (...args) => questions.wait(...args) },
      delegation: { pending: (...arguments_) => delegation.pending(...arguments_), execute: (...arguments_) => delegation.execute(...arguments_), assertShellExecutionAllowed: runId => delegation.assertShellExecutionAllowed(runId) },
      followUp: async (runId, signal) => { await chatQueueService?.followUp(runId, signal) },
      prepareForRun: signal => connectorService.prepareForRun(signal),
      shellSandbox: await host.start('runtime.shell_sandbox', ({ defer }) => {
        const sandbox = options.platform.createSandbox()
        const diagnostics = observeSandboxClient(sandbox, record)
        const prepareSpaces = (spaceId?: string) => {
          if (currentPlatform.shell !== 'powershell')
            return
          for (const space of spaceService.list()) {
            if (space.revokedAt || (spaceId && space.id !== spaceId))
              continue
            const roots = [...(space.primaryDirectory ? [space.primaryDirectory] : []), ...space.additionalDirectories]
              .filter(directory => !directory.revokedAt)
              .map(directory => directory.canonicalRoot)
            void sandbox.prepare(roots).catch(() => record({ event: 'sandbox.workspace_preparation.failed', level: 'warn', spaceId: space.id }))
          }
        }
        const preparedSpaces = spaceService.onDidCommit((event) => {
          if (event.facets.includes('directories') && event.kind !== 'deleted')
            prepareSpaces(event.spaceId)
        })
        const installed = options.platform.subscribeSandboxReady(() => prepareSpaces())
        prepareSpaces()
        defer(async () => {
          preparedSpaces.dispose()
          installed()
          await sandbox.dispose()
          diagnostics.dispose()
        })
        return sandbox
      }),
      approvalService,
      attachmentService,
      getInputProjection: (conversationId, messageId) => extensionReferences.inputProjection(conversationId, messageId),
      changeCaptureService,
      mutations,
      receiptDirectory: join(options.buddyHome, 'process-receipts'),
      directoryGrants,
      recordPermissions: record,
      createCapabilities: createBuddyCapabilityFactory(currentPlatform, {
        buddies,
        getRunBuddyId: runId => runs.findById(runId)?.buddyId ?? null,
        record,
        pluginAuthoring: options.platform.authoring,
        pluginBuilder,
        skillAuthoring: { skills: skillService, requestReview: options.platform.reviewSkill },
        pluginCapabilities: context => extensionAgent.capabilities(context),
        artifactService,
        attachmentService,
        automationService,
        browserHost,
        presentBrowser: async (source) => {
          try {
            await options.platform.presentBrowser?.(source)
          }
          catch {
            record({ event: 'context_panel.presentation.failed', level: 'warn', errorCode: 'CONTEXT_PANEL_UNAVAILABLE' })
          }
        },
        connectorService,
        imageRequests: new ImageRequestStore(paths),
        imageGenerationGateway,
        imageTransformService,
        webService,
        conversations,
        publications: treeRepository,
        executions: executionRecords,
        runInputs,
        runEvents: options.eventLog,
        references: sessionReferences,
        referenceSnapshots: extensionReferences,
      }, petActions),
    }
    const conversationMembers = createConversationMemberRepository(options.database)
    const buddyDefinitions = new BuddyDefinitionResolver({ buddies, members: conversationMembers, providers: providerService })
    const sessionBlueprints = new BuddySessionBlueprintService({
      conversationGrants: conversationDirectoryGrants,
      paths,
      spaces: spacesRepository,
      skills: skillService,
    })
    async function validateSpaceMoveTarget(conversation: ConversationRecord, spaceId: string): Promise<void> {
      if (!conversation.activeBranchId)
        throw new BuddyServiceError('VALIDATION_FAILED')
      await sessionBlueprints.createForConversation({
        approvalPolicy: conversation.approvalPolicy,
        branchId: conversation.activeBranchId,
        conversationId: conversation.id,
        executionProfile: conversation.executionProfile,
        sessionMode: 'interactive',
        spaceId,
      })
    }
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
        repository: treeRepository,
        threads,
        runs,
        isRunHistoryAvailable: runId => !options.eventLog.getRecoveryFailures().some(failure => failure.runId === runId),
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
    const getRunPermissionCeiling = (runId: string): BuddyExecutionProfile | undefined => {
      const run = runs.findById(runId)
      const content = run?.triggeringMessageId ? conversationHistory.repository.findMessageById(run.triggeringMessageId)?.content : undefined
      if (run?.executionProfile === 'read_only' && (run.executionKind !== 'root' || buddyUserMessageContentV1Schema.safeParse(content).data?.questionReply))
        return 'read_only'
      return isReviewUserMessage(content) ? 'read_only' : undefined
    }
    const getFileAccessCeiling = (runId: string): 'read_only' | undefined => {
      return executionRecords.find(runId)?.fileAccessCeiling === 'read_only'
        || runs.findById(runId)?.actorSnapshot?.settings.limits.fileAccess === 'read_only'
        || getRunPermissionCeiling(runId) === 'read_only'
        ? 'read_only'
        : undefined
    }
    const executionCoordinator = await host.start('runtime.execution_tree', ({ defer }) => {
      const service = new ExecutionCoordinator({
        availability: options.eventLog,
        assertRunAdmission: conversationAvailability.assertRunExecutable,
        hostShellSupervision: currentPlatform.hostShellSupervision,
        executions: executionRecords,
        mailbox: createMailboxRepository(options.database),
        events: options.eventLog,
        lifecycle: runLifecycleService,
        mutations,
        listIncomplete: () => runs.listIncomplete(),
        recoverQuarantinedRun: runId => runRecoveryService.recoverQuarantinedRun(runId),
        getFileAccessCeiling,
        onObserverError: () => record({ event: 'execution.tree_observer_failed', level: 'error' }),
        readResult: runId => readExecutionResult(options.eventLog, runId),
        launchChild: id => turnLauncher.launch(id),
        stopExecution: id => runner.interruptExecution(id),
        followUp: (runId, signal) => chatQueueService?.followUp(runId, signal) ?? Promise.resolve(false),
      })
      defer(() => service.dispose())
      return service
    })
    questions = await host.start('runtime.user_questions', ({ defer }) => {
      const service = new UserQuestionService({ database: options.database, executions: executionRecords, conversations, coordinator: executionCoordinator, deliver: request => questionDelivery.deliver(request) })
      const subscription = service.onDidChange(event => notify(userQuestionsChanged.method, { conversationId: event.conversationId, branchId: event.branchId, runId: event.runId }))
      defer(async () => {
        subscription.dispose()
        await service.dispose()
      })
      return service
    })
    delegation = new ExecutionDelegationService({
      readResult: runId => readExecutionResult(options.eventLog, runId),
      readToolOptions: signal => readBuddyToolOptions(sessionExtensionServices.createCapabilities, agentDirectory, signal, sessionExtensionServices.shells),
      actorTargets: (rootRunId) => {
        const run = runs.findById(rootRunId)
        const content = run ? buddyUserMessageContentV1Schema.safeParse(conversationHistory.repository.findMessageById(run.triggeringMessageId)?.content) : null
        return content?.success ? getBuddyUserContentActorReferences(content.data.userContent).map(actor => actor.actorId) : []
      },
      buddies,
      members: conversationMembers,
      definitions: buddyDefinitions,
      executions: executionRecords,
      mailbox: createMailboxRepository(options.database),
      coordinator: executionCoordinator,
      stopExecution: id => runner.interruptExecution(id),
    })
    const sessionFactory = await host.start('runtime.session_factory', () => {
      const service = new BuddySessionFactory({
        getRunPermissionCeiling,
        getFileAccessCeiling,
        bindPreferences: apply => bindRuntimePreferences(options.platform.preferences, apply),
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
    const executionPresentation = await host.start('runtime.execution_presentation', ({ defer }) => {
      const service = new ExecutionPresentationService({
        questions,
        approvals: approvalsRepository,
        conversations,
        runs,
        executions: executionRecords,
        mailbox: createMailboxRepository(options.database),
        buddies,
        coordinator: executionCoordinator,
        mutations,
        events: options.eventLog,
        artifacts: artifactsRepository,
        changes: changeCaptureService,
        usage: usageRepository,
        stopExecution: id => runner.interruptExecution(id),
        onObserverError: () => record({ event: 'execution.presentation_observer_failed', level: 'warn' }),
      })
      const subscription = service.onDidChange(event => notify(executionsChanged.method, event))
      defer(() => {
        subscription.dispose()
        service.dispose()
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
        assertStorageAvailable: storage.assertAvailable,
        executor: piTurnExecutor,
        executions: executionCoordinator,
        lifecycle: runLifecycleService,
        releaseRunResources: async (runId) => {
          const effects = await mutations.waitForRun(runId)
          await changeCaptureService.finalizeRun(runId)
          approvalService.clearRunAuthorizations(runId)
          if (effects.hazards.length)
            throw new Error('EXECUTION_CLEANUP_DEGRADED')
        },
        onObserverError: () => record({ event: 'execution.observer_failed', level: 'error' }),
        sessions,
      })
      const quarantine = options.eventLog.onDidQuarantine(async (failure) => {
        const run = runs.findById(failure.runId)
        if (!run)
          return
        await sessions.invalidateMatching(identity => identity.conversationId === run.conversationId
          && identity.branchId === run.branchId && identity.threadId === run.threadId)
        const root = runs.findById(run.rootRunId)
        if (root?.status === 'queued' || root?.status === 'running') {
          chatQueueService?.pause(root)
          await service.cancel(root.id, 'EVENT_LOG_CORRUPTED')
        }
        runRecoveryService.recoverQuarantinedRun(run.id)
      })
      defer(() => quarantine.dispose())
      const settledQuestions = service.onDidSettle((settled) => {
        if (!settled.stopping)
          void questions.executionSettled(settled.runId).catch(() => record({ event: 'question.delivery_failed', level: 'error' }))
      })
      defer(() => settledQuestions.dispose())
      const settledDiagnostics = service.onDidSettle(settled => record({
        event: 'execution.settled',
        level: settled.cleanup === 'degraded' ? 'warn' : 'info',
        runId: settled.runId,
        conversationId: settled.conversationId,
        operationId: settled.executionId,
        ...(settled.cleanup === 'degraded' ? { errorCode: 'EXECUTION_CLEANUP_DEGRADED' } : {}),
      }))
      const executionLifecycle = new RuntimeExecutionLifecycle({
        scheduler: () => automationScheduler,
        dispatcher: () => automationDispatcher,
        disposeExecutions: () => service.dispose(),
      })
      stopExecution = () => executionLifecycle.stop()
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
    let extensionActions: ExtensionActionService
    const conversationPurge = new ConversationPurgeService({ database: options.database, home: paths.root, storageAuthority: commandContext ? 'sqlite' : 'legacy_jsonl' })
    const conversationLifecycle = await host.start('runtime.task_deletion', ({ defer }) => {
      const service = new ConversationLifecycleService({
        conversations,
        deletion: createConversationDeletionRepository(options.database),
        assertWritable: id => conversationMutations.assertWritable(id),
        runner,
        cancelQueuedRuns: async (conversationId) => {
          try {
            for (const run of runs.listIncomplete()) {
              if (run.conversationId === conversationId && run.status === 'queued')
                await runLifecycleService.finalize({ runId: run.id, status: 'cancelled', errorCode: 'RUN_CANCELLED', completedAt: new Date().toISOString() })
            }
          }
          catch (error) {
            if (!(error instanceof RunEventCorruptionError))
              throw error
          }
        },
        sessions: { invalidateConversation: id => sessions.invalidateConversationWithResult(id) },
        stopWriters: async (conversationId) => {
          chatQueue.pause(conversationId)
          await extensionActions.cancelAndWait(conversationId)
        },
        purge: id => attachmentService.withStorageScope(() => options.eventLog instanceof RunEventLog
          ? options.eventLog.withConversationPurge(id, () => conversationPurge.purge(id))
          : conversationPurge.purge(id)),
        onObserverError: () => record({ event: 'task.deletion_observer_failed', level: 'warn' }),
      })
      const notification = service.onDidCommit((event) => {
        const conversation = conversations.findById(event.conversationId)
        if (conversation)
          notify(CONVERSATION_CHANGED, conversation)
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
    extensionActions = await host.start('runtime.plugin_actions', ({ defer }) => {
      const service = new ExtensionActionService({
        runtime: extensionAgent,
        repository: createExtensionInvocationRepository(options.database),
        capture: (conversationId, source) => extensionTaskContext.captureAction(conversationId, source),
        onObserverError: () => record({ event: 'plugins.action.observer_failed', level: 'warn' }),
      })
      const binding = bindExtensionActions(service, { turns: turnRequests, execution: runner, metadata: conversationMetadata, deletions: conversationLifecycle, runs, events: options.eventLog })
      const diagnostics = service.onDidFail(event => record({ event: 'plugins.action.failed', level: 'warn', ...event }))
      const notification = service.onDidChange(event => notify(conversationTimelineChanged.method, event))
      defer(async () => {
        binding.dispose()
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
      getFileAccessCeiling,
      definitions: buddyDefinitions,
      attachments: attachmentService,
      commands: commandRequests,
      conversations,
      models: executionModels,
      runInputs,
      runs,
      sessions: sessionBlueprints,
      skills: skillService,
    })
    turnLauncher = new BuddyTurnLauncher({
      assertServiceAccepting: () => {
        assertPlatformAvailable()
        commandContext?.repository.assertAccepting()
      },
      assertStorageAvailable: storage.assertAvailable,
      executions: executionCoordinator,
      planner: executionPlanner,
      runner,
      beforeRun: async (runId, signal) => {
        const run = runs.findById(runId)
        if (run?.purpose === 'chat')
          await extensionActions.beforeRun({ type: 'task:run:before', data: { conversationId: run.conversationId, branchId: run.branchId, runId, messageId: run.triggeringMessageId } }, signal)
      },
    })
    const chatCommandService = await host.start('runtime.chat_commands', ({ defer }) => {
      const service = new ChatCommandService({
        availability: conversationAvailability,
        commands: commandRequests,
        conversationLifecycle,
        conversations,
        drafts: personalDrafts,
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
        definitions: buddyDefinitions,
        getDefaultBuddyId: () => buddies.defaultBuddyId,
        inputValidation: new ChatInputValidationService({
          attachments: attachmentService,
          models: executionModels,
          paths,
          runInputs,
          runs,
          sessions,
          tree: conversationTree,
        }),
        composerResources: composerResourceService,
        drafts: personalDrafts,
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
    questionDelivery = new UserQuestionDelivery({ database: options.database, executions: executionRecords, mailbox: createMailboxRepository(options.database), coordinator: executionCoordinator, runner, turns: chatTurnService })
    chatQueueService = await host.start('runtime.chat-queue', async ({ defer }) => {
      const service = new ChatQueueService({ control: commandContext?.repository, availability: conversationAvailability, queue: chatQueue, turns: chatTurnService, requests: turnRequests, launcher: turnLauncher, runner, runs, runInputs, getRunPermissionCeiling, eventLog: options.eventLog, onObserverError: () => record({ event: 'queue.observer_failed', level: 'error' }) })
      const sourceId = randomUUID()
      let revision = 0
      const notification = service.onDidChange((event) => {
        if (event.kind === 'delivered' || event.kind === 'dispatched')
          notify(conversationTimelineChanged.method, { sourceId, revision: ++revision, ...event.scope })
      })
      const actionInputs = service.onDidChange((event) => {
        if (event.kind === 'cancelled')
          void questions.retryPending(event.scope).catch(() => record({ event: 'questions.delivery_reconcile_failed', level: 'error' }))
        if (event.kind === 'enqueued' || event.kind === 'cancelled') {
          const active = chatQueue.activeRun(event.scope)
          if (active)
            executionCoordinator.notifyQueuedInput(active.id)
        }
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
        notification.dispose()
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
    const conversationArchive = await host.start('runtime.task_archive', ({ defer }) => {
      const onError = () => record({ event: 'task.archive_failed', level: 'warn' as const })
      const service = new ConversationArchiveService({
        database: options.database,
        repository: createConversationArchiveRepository(options.database),
        conversations,
        mutations: conversationMutations,
        lifecycle: conversationLifecycle,
        ...(commandContext ? { afterCommit: (publish: () => void) => afterTransactionCommit(options.database, publish, onError) } : {}),
        onError,
      })
      const subscription = service.onDidChange((id) => {
        const conversation = conversations.findById(id)
        if (conversation)
          notify(CONVERSATION_CHANGED, conversation)
      })
      defer(async () => {
        await service.dispose()
        subscription.dispose()
      })
      return service
    })
    const remoteUploads = commandContext
      ? await host.start('runtime.remote_uploads', ({ defer }) => {
          const service = new RemoteUploadService({ database: options.database, root: paths.root, instanceId: commandContext.identity.serviceInstanceId, drafts: composerDraftService })
          defer(() => service.close())
          return service
        })
      : null
    const createActorCommands = (principal: TrustedCommandPrincipal): BuddyServiceCommands => {
      if (!commandContext)
        throw new ProductProtocolError('SERVICE_NOT_READY')
      const scope = actorCommandScopes.get(principal.actorId) ?? new ProductActorCommandScope(options.database, principal, commandContext.identity)
      actorCommandScopes.set(principal.actorId, scope)
      const draftAccess = {
        find: (id: string) => personalDrafts.findById(id),
        run: <T>(id: string, operation: () => T | Promise<T>) => composerDraftService.withDraftLock(id, operation),
        withDraftLock: <T>(id: string, operation: () => T | Promise<T>) => composerDraftService.withDraftLock(id, operation),
        notifyCommitted: composerDraftService.notifyCommitted.bind(composerDraftService),
      }
      return scope.initialize({
        runs: { turns: turnRequests, events: commandContext.writer },
        input: { turns: chatTurnService, compact: chatCommandService, queue: chatQueueService!, assertExecutionAvailable: assertPlatformAvailable },
        drafts: { access: draftAccess, prepareAttachments: input => attachmentService.prepareDraftCopy(input), releaseResources: draftId => composerResourceService.discard(draftId) },
        conversations: { metadata: conversationMetadata, lifecycle: conversationLifecycle, archive: conversationArchive ?? undefined, marks: taskMarks },
        control: { repository: commandContext.repository, queue: chatQueueService!, stopExecution: () => stopExecution() },
        uploads: remoteUploads!,
        questions,
        approvals: approvalService,
        openDesktop: options.platform.openDesktop,
        onError: () => record({ event: 'command.dispatch_failed', level: 'error' }),
      })
    }
    const commands = commandContext
      ? await host.start('runtime.input_commands', ({ defer }) => {
          defer(async () => {
            await Promise.all([...actorCommandScopes.values()].map(scope => scope.dispose()))
          })
          return createActorCommands(commandContext.principal)
        })
      : null
    const runtime: BuddyRuntime = {
      startTurn: async (input) => {
        if (commands)
          throw new ProductCommandRequiredError()
        storage.assertAvailable()
        assertPlatformAvailable()
        commandContext?.repository.assertAccepting()
        const result = await chatTurnService.start(input)
        storage.assertAvailable()
        return result
      },
    }
    const statistics = await host.start('runtime.conversation_statistics', ({ defer }) => {
      const service = new ConversationStatusService({
        repository: createConversationStatisticsRepository(options.database),
        runs,
        events: options.eventLog,
        getCacheWarmingStatus: (conversationId) => {
          const conversation = conversations.findById(conversationId)
          const branchId = conversation?.activeBranchId
          return branchId ? sessions.getReady(conversationId, branchId, conversation?.buddyId)?.getCacheWarmingStatus?.() ?? null : null
        },
      })
      const notices = service.onDidChange(event => notify(taskMetricsChanged.method, event))
      const inputs = chatQueueService.onDidChange((event) => {
        if (event.kind === 'delivered' || event.kind === 'dispatched')
          service.notifyChanged(event.scope.conversationId)
      })
      const reconciled = runLifecycleService.onDidReconcile(event => service.notifyChanged(event.conversationId))
      defer(() => {
        reconciled.dispose()
        inputs.dispose()
        notices.dispose()
        service.dispose()
      })
      return service
    })
    const contextUsageService = new ContextUsageSnapshotService({
      runs,
      threads,
      events: options.eventLog,
      definitions: buddyDefinitions,
      getDefaultActorId: () => buddies.defaultBuddyId,
      getRuntimePreferences: options.platform.preferences.get,
      drafts: composerDrafts,
      tree: conversationTree,
      agentDirectory,
      blueprints: sessionBlueprints,
      conversations,
      models: executionModels,
      paths,
      sessionExtensionServices,
    })
    const dispatcher = await host.start('runtime.automation_dispatcher', ({ defer }) => {
      const service = new AutomationDispatcher(automationService, new AgentTaskAutomationAction({
        automationService,
        cancelRun: (runId, errorCode) => runner.cancel(runId, errorCode),
        clock: automationClock,
        launchTurn: (runId, signal) => turnLauncher.launch(runId, signal),
        resolveModel: (target, actorModel) => resolveAutomationModelSelection({
          defaults: providerService,
          models: executionModels,
        }, target, actorModel),
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
      canDispatch: () => platformLifecycle.available,
      dispatch: occurrence => dispatcher.dispatch(occurrence),
      onObserverError: () => record({ event: 'automation.scheduler_observer_failed', level: 'warn' }),
    })
    automationScheduler = scheduler

    const isBusy = () => conversationLifecycle.hasPendingOperations
      || [...actorCommandScopes.values()].some(scope => scope.hasPendingOperations)
      || runner.hasActiveExecutions
      || composerDraftService.hasPendingOperations
      || chatTurnService.hasPendingOperations
      || chatCommandService.hasPendingOperations
      || chatQueueService!.hasPendingOperations
      || dispatcher.hasPendingOperations
      || runs.hasIncomplete()
      || chatQueue.hasWaiting()
      || approvalsRepository.listPending().some((approval) => {
        const run = runs.findById(approval.runId)
        return run?.status === 'queued' || run?.status === 'running'
      })

    await host.step('runtime.recovery', async () => {
      await automationOccurrenceLifecycle.recoverPendingDeletions()
      await conversationLifecycle.recoverPendingDeletions()
      const count = await runRecoveryService.recoverInterruptedRuns()
      record({ event: 'runtime.runs_recovered', level: 'info', count })
    })

    let privateNetwork: PrivateNetworkController | null = null
    const registerClient = await host.start('runtime.rpc', ({ defer }) => {
      defer(() => clients.stopAccepting())
      defer(options.platform.bindInternal({
        attachments: attachmentService,
        conditions: { tasks: conversations, history: extensionHistory, runs, inputs: runInputs, providers: providerService },
        speech: { providers: providerService, workspace },
      }))
      defer(options.platform.subscribeWake(() => automationChanges.wakeScheduler()))
      return (connection: RuntimeRequestRegistrar, role: ServiceClientRole) => {
        const rpc = connection
        const conditionalRpc = commandContext && role === 'product' ? candidateLegacyRegistrar(connection) : connection
        if (role === 'management') {
          privateNetwork?.register(rpc)
          {
            const cleanup = new ConversationCleanupService({
              database: options.database,
              archive: conversationArchive,
              lifecycle: conversationLifecycle,
              execute: async (intent) => {
                if (!commands || !commandContext)
                  return conversationArchive.deleteLegacyRemoved(intent)
                const receipt = await commands.metadata.execute('conversations.deleteLegacyRemoved', {
                  commandId: randomUUID(),
                  dataGeneration: commandContext.identity.dataGeneration,
                  expectedServiceInstanceId: commandContext.identity.serviceInstanceId,
                  intent,
                })
                return receipt.receipt.decision === 'accepted'
              },
            })
            registerConversationCleanupRpc({ rpc, cleanup })
          }
          if (commandContext) {
            const references = new ProductContentReferences(options.database, commandContext.principal.actorId)
            registerRuntimeRequest(rpc, desktopProductContentProject, input => ({ content: references.project(input.content) }))
            registerComposerResourceRpc({ drafts: composerDraftService, rpc, service: composerResourceService })
          }
          registerWebSettingsRpc(rpc, webSettings)
          registerWorkspaceStateRpc({
            service: workspaceStateService,
            rpc,
          })
          registerAutomationRpc({
            approvals: approvalsRepository,
            changes: automationChanges,
            clock: automationClock,
            lifecycle: automationOccurrenceLifecycle,
            rpc,
            runs,
            service: automationService,
          })
          registerMcpConnectorRpc(rpc, connectorService)
          registerSpaceRpc({
            rpc,
            service: spaceService,
          })
          registerLocalDocumentRpc(rpc, new LocalDocumentFileService(options.buddyHome, fileEngine, async (source) => {
            const location = source.kind === 'artifact'
              ? await artifactService.locate(source.artifactId)
              : source.kind === 'space' ? await spaceFiles.locate(source.target) : await taskFileService.locate(source.target)
            if (location.kind !== 'file')
              throw new Error('FILE_PERMISSION_REVOKED')
            return location.path
          }))
          registerSpaceFileRpc(rpc, spaceFiles)
          registerProviderRpc({
            rpc,
            service: providerService,
            refreshCapabilities: async () => {
              await Promise.all([options.platform.refreshProviderSpeech({ providers: providerService, workspace }), pluginModels.refresh()])
            },
          })
          registerSkillServiceRpc(rpc, skillService)
          registerRuntimeRequest(rpc, extensionActionRpc.list, (_input, signal) => extensionActions.list(signal))
          registerRuntimeRequest(rpc, extensionActionRpc.invoke, (input, signal) => extensionActions.invoke(input, signal))
          return
        }
        registerProviderCatalogRpc({ rpc, service: providerService, refreshCapabilities: async () => {
          await Promise.all([options.platform.refreshProviderSpeech({ providers: providerService, workspace }), pluginModels.refresh()])
        } })
        registerSpaceQueries({ rpc, service: spaceService })
        registerSkillCatalogRpc(rpc, skillService)
        registerNotificationRpc({
          rpc,
          service: notificationService,
        })
        registerArtifactRpc({
          rpc,
          service: artifactService,
        })
        registerChangeRpc({
          conversations,
          runs,
          rpc,
          service: changeCaptureService,
          recovery: mutationRecovery,
        })
        registerRunRpc({
          statistics,
          isBusy,
          eventLog: options.eventLog,
          inputs: runInputs,
          repository: runs,
          rpc,
        })
        registerRuntimeRequest(rpc, promptsRpc.get, () => getBuiltinPromptCatalog())
        registerContextPanelRpc({ rpc, runs, events: options.eventLog })
        registerUserQuestionRpc({ rpc: conditionalRpc, service: questions })
        registerExecutionRpc({ rpc, service: executionPresentation, inputs: new ExecutionComposerInputService({ drafts: composerDraftService, conversations, executions: executionRecords, getRunPermissionCeiling, mailbox: createMailboxRepository(options.database), delivery: executionPresentation }) })
        if (!commandContext) {
          registerComposerResourceRpc({ drafts: composerDraftService, rpc, service: composerResourceService })
        }
        registerComposerDraftRpc({
          rpc: conditionalRpc,
          service: composerDraftService,
        })
        registerUsageRpc({
          analytics: createUsageAnalyticsRepository(options.database),
          repository: usageRepository,
          rpc,
        })
        registerChatRpc({
          attachments: attachmentService,
          conversations,
          drafts: composerDraftService,
          commands: chatCommandService,
          rpc: conditionalRpc,
          runtime,
          turns: chatTurnService,
          queue: chatQueueService,
        })
        registerContextRpc({
          rpc,
          service: contextUsageService,
        })
        registerBuddiesRpc(rpc, buddies, signal => readBuddyToolOptions(sessionExtensionServices.createCapabilities, agentDirectory, signal, sessionExtensionServices.shells))
        registerTaskMarkRpc(conditionalRpc, taskMarks, taskAttention)
        registerConversationTreeRpc({
          database: options.database,
          conversations,
          rpc,
          artifacts: artifactsRepository,
          attachments: attachmentService,
          changes: changeCaptureService,
          eventLog: options.eventLog,
          runInputs,
          runs,
        })
        registerConversationArchiveRpc({ rpc: conditionalRpc, archive: conversationArchive, legacyWrites: !commandContext })
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
          rpc: conditionalRpc,
          runInputs,
          runs,
        })
        registerApprovalRpc({
          commandService: commands ? approvalService : undefined,
          repository: approvalsRepository,
          rpc: conditionalRpc,
          service: approvalService,
        })
        registerTaskFileRpc(rpc, taskFileService)
        rpc.onRequest(imageRpc.catalog, async () => {
          await pluginModels.refresh()
          return { ...await imageGenerationGateway.catalog(), readingCandidates: await imageReading.candidates() }
        })
      }
    })
    conversationArchive.start()
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
    const remoteResources = commandContext
      ? await host.start('runtime.remote_resources', ({ defer }) => {
          const service = new RemoteResourceService({ database: options.database, root: paths.root, instanceId: commandContext.identity.serviceInstanceId, artifacts: artifactService, views: actorId => new ProductQueries(options.database, actorId, commandContext.identity.serviceInstanceId).views })
          defer(() => service.close())
          return service
        })
      : null
    const productQueries = commandContext ? new ProductQueries(options.database, commandContext.principal.actorId, commandContext.identity.serviceInstanceId, undefined, (id, version) => remoteResources!.hasReview(commandContext.principal.actorId, id, version)) : null
    const productSync = productQueries ? createProductSynchronization({ database: options.database, queries: productQueries, drafts: composerDraftService, metadata: conversationMetadata, lifecycle: conversationLifecycle, archive: conversationArchive ?? undefined, marks: taskMarks, questions, events: options.eventLog, queue: chatQueueService }) : null
    const actorProductScopes = new Map<string, { commands: BuddyServiceCommands, queries: ProductQueries, sync: ReturnType<typeof createProductSynchronization> }>()
    if (commands && productQueries && productSync)
      actorProductScopes.set(commandContext!.principal.actorId, { commands, queries: productQueries, sync: productSync })
    let productStopping = false
    const productConnections = new Set<ProductConnection>()
    const createProductConnection: BuddyServiceHandle['createProductConnection'] = (connectionOptions) => {
      if (!commands || !commandContext)
        throw new ProductProtocolError('SERVICE_NOT_READY')
      const context = Object.freeze({ ...connectionOptions.context })
      const assertOwner = () => {
        connectionOptions.assertCurrent()
        storage.assertAvailable()
        commandContext.principal.assertAuthenticated()
        if (context.profileId !== options.productIdentity!.profileId || context.serviceId !== options.productIdentity!.serviceId)
          throw new ProductProtocolError('NOT_AUTHORIZED')
        if (context.ownerPrincipalId !== commandContext.principal.actorId)
          throw new ProductProtocolError('NOT_AUTHORIZED')
        if (context.dataGeneration !== commands.identity.dataGeneration)
          throw new ProductProtocolError('DATA_GENERATION_CHANGED')
        if (context.serviceInstanceId !== commands.identity.serviceInstanceId)
          throw new ProductProtocolError('SERVICE_INSTANCE_CHANGED')
      }
      assertOwner()
      const principal = connectionOptions.trustedPrincipal ?? commandContext.principal
      if (principal.actorId !== context.deviceId)
        throw new ProductProtocolError('NOT_AUTHORIZED')
      principal.assertAuthenticated()
      let scope = actorProductScopes.get(principal.actorId)
      if (!scope) {
        const queries = new ProductQueries(options.database, principal.actorId, commandContext.identity.serviceInstanceId, undefined, (id, version) => remoteResources!.hasReview(principal.actorId, id, version))
        scope = { commands: createActorCommands(principal), queries, sync: createProductSynchronization({ database: options.database, queries, drafts: composerDraftService, metadata: conversationMetadata, lifecycle: conversationLifecycle, archive: conversationArchive ?? undefined, marks: taskMarks, questions, events: options.eventLog, queue: chatQueueService }) }
        actorProductScopes.set(principal.actorId, scope)
      }
      const actorScope = scope
      const connection = new ProductConnection({
        ...connectionOptions,
        context,
        assertCurrent: assertOwner,
        sync: actorScope.sync.publisher,
        authorizeTopic: (topic) => {
          assertOwner()
          actorScope.sync.authorizeTopic(topic)
        },
        phase: () => productStopping ? 'stopping' : 'ready',
        handlers: { 'resources.prepare': { handle: input => remoteResources!.prepare(resourcePrepareSchema.parse(input), principal) }, ...actorScope.queries.handlers(), ...createProductModelQueries(providerService, id => id ? conversationMetadata.getModelControls(id).next.modelSelection : buddies.get(buddies.defaultBuddyId).settings.model), ...createProductCommandHandlers({ commands: actorScope.commands, assertOwner, hasReview: (id, version) => remoteResources!.hasReview(principal.actorId, id, version), assertExecutionAvailable: assertPlatformAvailable, allowLocalEffects: principal.actorId === commandContext.principal.actorId && connectionOptions.allowLocalEffects, allowedActions: new Set(['compact']), resolveQuote: resourceId => actorScope.queries.resolveQuote(resourceId) }) },
        close: () => {
          productConnections.delete(connection)
          connectionOptions.close()
        },
      })
      productConnections.add(connection)
      return connection
    }
    const createLocalProductConnection: BuddyServiceHandle['createLocalProductConnection'] = (transport) => {
      if (!commands || !commandContext || !options.productIdentity)
        throw new ProductProtocolError('SERVICE_NOT_READY')
      return createProductConnection({ ...transport, allowLocalEffects: true, context: { ...options.productIdentity, ...commands.identity, ownerPrincipalId: commandContext.principal.actorId, deviceId: commandContext.principal.actorId, credentialId: commandContext.principal.actorId, grantGeneration: '0', role: 'owner', connectionId: transport.connectionId, clientSessionId: randomUUID() } })
    }
    if (commandContext && options.productIdentity) {
      privateNetwork = await host.start('runtime.private_network', async ({ defer }) => {
        const avatars = new RemoteAvatarService(options.database)
        const controller: PrivateNetworkController = new PrivateNetworkController({ database: options.database, ...options.productIdentity!, serviceInstanceId: commandContext.identity.serviceInstanceId, secrets: options.platform.privateNetworkSecrets, bytes: async (request, response, identity) => avatars.bytes(request, response, controller.auth.principal(identity)) || await remoteUploads!.bytes(request, response, controller.auth.principal(identity)) || await remoteResources!.bytes(request, response, controller.auth.principal(identity)), connect: (identity, transport) => createProductConnection({ ...transport, context: controller.auth.context(identity), assertCurrent: () => controller.auth.assertCurrent(identity), trustedPrincipal: controller.auth.principal(identity) }) })
        defer(() => controller.close())
        await controller.restore()
        return controller
      })
    }
    const platformRecovery = {
      pauseContinuations: () => { for (const scope of chatQueueService!.continuationScopes()) chatQueueService!.pause(scope) },
      incompleteRunIds: () => runs.listIncomplete().map(run => run.id),
      cancelRun: (id: string, reason: string) => runner.cancel(id, reason),
      suspendConnectors: () => connectorService.suspendPlatform(),
      resumeConnectors: () => connectorService.resumePlatform(),
      invalidateSessions: () => sessions.invalidateAll(),
      isStopping: () => productStopping,
    }
    return {
      commands,
      createProductConnection,
      createLocalProductConnection,
      assertPlatformAvailable,
      suspendPlatform: reason => platformLifecycle.suspend(platformRecovery, reason),
      resumePlatform: () => platformLifecycle.resume(platformRecovery),
      connectClient: (role, peer) => {
        const disconnect = clients.connect(role, peer, registerClient)
        if (!commands || !commandContext || role !== 'product' || !options.productIdentity)
          return disconnect
        try {
          const stopProduct = registerLocalProductConnection(peer, transport => createLocalProductConnection({
            ...transport,
            connectionId: randomUUID(),
            assertCurrent: () => {
              if (peer.closed)
                throw new ProductProtocolError('NOT_AUTHORIZED')
            },
          }))
          return () => {
            stopProduct()
            disconnect()
          }
        }
        catch (error) {
          disconnect()
          throw error
        }
      },
      startMaintenance: () => options.eventLog.startMaintenance({ isBusy }),
      async dispose() {
        productStopping = true
        for (const [actorId, scope] of actorProductScopes) {
          scope.sync.stopping()
          scope.sync.dispose()
          actorCommandScopes.get(actorId)!.stopAccepting()
        }
        for (const connection of productConnections) connection.close()
        for (const scope of actorCommandScopes.values()) scope.stopAccepting()
        clients.stopAccepting()
        try {
          await options.eventLog.stopMaintenance()
        }
        finally {
          await host.stop().finally(stopLifecycleDiagnostics)
        }
      },
      prepareIdleShutdown() {
        if (isBusy())
          return false
        productStopping = true
        for (const scope of actorCommandScopes.values()) scope.stopAccepting()
        clients.stopAccepting()
        void options.eventLog.stopMaintenance().catch(() => record({ event: 'runtime.maintenance.stop_failed', level: 'error' }))
        void composerDraftService.dispose()
        void chatTurnService.dispose()
        void chatCommandService.dispose()
        chatQueueService!.dispose()
        void scheduler.dispose()
        dispatcher.stop()
        return true
      },
      runtime,
    }
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
