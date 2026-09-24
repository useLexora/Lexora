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
import { automationNotifications } from '../../shared/automation/automationApi'
import { contextPanelRpc, contextPanelStateSchema } from '../../shared/context-panel/contextPanel'
import { ServiceHost } from '../../shared/lifecycle/ServiceHost'
import { ApplicationEvents as EventPublisher } from '../../shared/observability/ApplicationEvents'
import { openExternalResultSchema } from '../../shared/runtime/credentialProtocol'
import { PiEventBridge } from './agent/events/PiEventBridge'
import { BuddyAgentRunner } from './agent/execution/BuddyAgentRunner'
import { BuddyRunExecutionPlanner } from './agent/execution/BuddyRunExecutionPlanner'
import { BuddyTurnLauncher } from './agent/execution/BuddyTurnLauncher'
import { PiTurnExecutor } from './agent/execution/PiTurnExecutor'
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
import { registerChatRpc } from './chat/registerChatRpc'
import { registerComposerDraftRpc } from './chat/registerComposerDraftRpc'
import {
  HostConnectorSecretStore,
  McpConnectorService,
} from './connectors/mcp/McpConnectorService'
import { registerMcpConnectorRpc } from './connectors/mcp/registerMcpConnectorRpc'
import { registerContextPanelRpc } from './context-panel/registerContextPanelRpc'
import { ContextUsageSnapshotService } from './context/ContextUsageSnapshotService'
import { registerContextRpc } from './context/registerContextRpc'
import { ConversationLifecycleService } from './conversations/ConversationLifecycleService'
import { registerConversationRpc } from './conversations/registerConversationRpc'
import { registerConversationTreeRpc } from './conversations/registerConversationTreeRpc'
import { registerTaskMarkRpc } from './conversations/registerTaskMarkRpc'
import { createBuddyCapabilityFactory } from './createBuddyCapabilityFactory'
import { DirectoryGrantService } from './directories/DirectoryGrantService'
import { ImageTransformService } from './images/ImageTransformService'
import { OpenAiImageGenerationService } from './images/OpenAiImageGenerationService'
import { AttentionNotificationService } from './notifications/AttentionNotificationService'
import { registerNotificationRpc } from './notifications/registerNotificationRpc'
import { createProviderService } from './providers/createProviderService'
import { registerProviderRpc } from './providers/registerProviderRpc'

import { resolveInteractiveModelSelection } from './providers/resolveInteractiveModelSelection'
import { BuddyServiceError } from './rpc/runtimeRequest'
import { registerRunRpc } from './runs/registerRunRpc'
import { RunLifecycleService } from './runs/RunLifecycleService'
import { RunRecoveryService } from './runs/RunRecoveryService'
import { ShellSandboxClient } from './sandbox/ShellSandboxClient'
import {
  registerSkillServiceRpc,
  SkillService,
} from './skills/SkillService'
import { registerSpaceFileRpc } from './spaces/registerSpaceFileRpc'
import { registerSpaceRpc } from './spaces/registerSpaceRpc'
import { matchesSpaceExecutionContext } from './spaces/spaceExecutionContext'
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
import { createConversationDirectoryGrantRepository } from './storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from './storage/conversationRepository'
import { createConversationTreeRepository } from './storage/conversationTreeRepository'
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
import { WebCapabilityService } from './web/WebCapabilityService'
import { WebHostClient } from './web/WebHostClient'
import { registerWebSettingsRpc, WebSettingsService } from './web/WebSettingsService'
import { normalizeComposerWorkspace } from './workspace/normalizeComposerWorkspace'
import { registerWorkspaceStateRpc } from './workspace/registerWorkspaceStateRpc'

export interface StartBuddyServiceOptions {
  record?: ApplicationDiagnosticReporter
  events?: ApplicationEvents
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
  const host = new ServiceHost(events)
  const record = events.publish
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
    const conversationDirectoryGrants = createConversationDirectoryGrantRepository(options.database)
    const runInputs = createRunInputRepository(options.database)
    const approvalsRepository = createApprovalRepository(options.database)
    const usageRepository = createUsageRepository(options.database)
    const workspace = createWorkspaceRepository(options.database)
    const turnRequests = createTurnRequestRepository(options.database)
    const composerDrafts = createComposerDraftRepository(options.database)
    const commandRequests = createCommandRequestRepository(options.database)
    const connectorsRepository = createConnectorRepository(options.database)
    const spaceService = new SpaceService(spacesRepository)
    let runner!: BuddyAgentRunner
    const approvalService = await host.start('runtime.approvals', () => {
      const service = new ApprovalService({
        eventLog: options.eventLog,
        onExpired: async (runId) => {
          await runner.cancel(runId, 'AUTOMATION_APPROVAL_EXPIRED')
        },
        repository: approvalsRepository,
      })
      return service
    })
    const usageService = await host.start('runtime.usage', () => {
      const service = new UsageService({
        eventLog: options.eventLog,
        repository: usageRepository,
      })
      return service
    })
    const piEventBridge = new PiEventBridge({
      record,
      eventLog: options.eventLog,
      usage: usageService,
    })
    const runLifecycleService = new RunLifecycleService({
      record,
      eventLog: options.eventLog,
      repository: runs,
    })
    const changeCaptureService = new ChangeCaptureService({
      paths,
      repository: createChangeSetRepository(options.database),
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
    const attachmentService = new AttachmentService({
      paths,
      repository: createAttachmentRepository(options.database),
    })
    const artifactsRepository = createArtifactRepository(options.database)
    const artifactService = new ArtifactService({ repository: artifactsRepository })
    await host.step('runtime.artifacts', () => reconcileLegacyArtifactOutputs({
      artifacts: artifactsRepository,
      conversations,
      eventLog: options.eventLog,
      paths,
    }))
    const composerResourceService = new ComposerResourceService({
      artifacts: artifactService,
      attachments: attachmentService,
      conversationGrants: conversationDirectoryGrants,
      conversations,
      drafts: composerDrafts,
      eventLog: options.eventLog,
      paths,
      repository: createComposerResourceRepository(options.database),
      spaces: spacesRepository,
    })
    await host.step('runtime.attachments', async () => {
      const attachmentRecovery = await attachmentService.reconcileStorage()
      composerResourceService.recoverInterruptedImports([
        ...attachmentRecovery.invalidAttachmentIds,
        ...attachmentRecovery.missingAttachmentIds,
      ])
      await composerResourceService.cleanupDrafts()
    })
    const imageTransformService = new ImageTransformService({ artifacts: artifactService })
    const providersRepository = createProviderRepository(options.database)
    const providerService = await host.start('runtime.providers', () => createProviderService({
      agentDirectory,
      database: options.database,
      getActiveRuns: () => runs.listIncomplete(),
      peer: options.rpc,
      providers: providersRepository,
      record,
    }))
    const executionModels = providerService.executionModels
    const imageGenerationGateway = new OpenAiImageGenerationService({
      modelRuntime: executionModels.getRuntime(),
      resolveSourceProviderId: providerId => executionModels.resolveSourceProviderId(providerId),
    })
    const sessions = await host.start('runtime.sessions', () => new BuddySessionRegistry<ReusableBuddySession>())
    const directoryGrants = new DirectoryGrantService({
      conversationGrants: conversationDirectoryGrants,
      conversations,
      spaces: spaceService,
    })
    const connectorService = await host.start('runtime.connectors', ({ defer }) => {
      const service = new McpConnectorService({
        connectors: connectorsRepository,
        openExternal: async (url) => {
          const result = openExternalResultSchema.parse(await options.rpc.request('host.openExternal', { url }))
          if (!result.ok)
            throw new Error('MCP authorization page is unavailable')
        },
        invalidateSessions: () => sessions.invalidateAll(),
        notify: (event) => {
          record({ event: event.type, level: event.code ? 'warn' : 'info', component: 'runtime.connectors', connectorId: event.connectorId, errorCode: event.code })
          options.rpc.notify(event.type, event)
        },
        secrets: new HostConnectorSecretStore(options.rpc),
      })
      defer(() => service.close())
      service.start()
      return service
    })
    const skillService = await host.start('runtime.skills', async ({ defer }) => {
      const service = new SkillService({
        agentDirectory,
        builtinSkillsDirectories: options.builtinSkillsDirectories,
        spaces: spacesRepository,
        repository: createSkillRepository(options.database),
        paths,
        changed: async (spaceId) => {
          await (spaceId ? sessions.invalidateSpace(spaceId) : sessions.invalidateAll())
          options.rpc.notify('skills.changed', { spaceId })
        },
      })
      defer(() => service.dispose())
      await service.initialize()
      return service
    })
    const browserHost = new BrowserHostClient(options.rpc)
    const webSettings = new WebSettingsService(workspace, options.rpc)
    const webService = await host.start('runtime.web', ({ defer }) => {
      const service = new WebCapabilityService({
        host: new WebHostClient(options.rpc),
        models: executionModels.getRuntime(),
        paths,
        settings: webSettings,
      })
      defer(() => service.dispose())
      return service
    })
    const automationClock = options.automationClock ?? systemAutomationClock
    const automationRepositories = createAutomationRepositories(options.database)
    const automationTurns = createAutomationTurnRepository(options.database)
    const automationService = new AutomationService({
      clock: automationClock,
      repositories: automationRepositories,
    })
    const notificationService = await host.start('runtime.notifications', () => {
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
      return service
    })
    let automationScheduler: AutomationScheduler | null = null
    const automationChanges = new AutomationChangeCoordinator({
      notify: (automationId) => {
        record({ event: 'automation.changed', level: 'info', automationId })
        options.rpc.notify(automationNotifications.changed.method, { automationId })
      },
      service: automationService,
      wakeScheduler: () => automationScheduler?.wake(),
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
    let chatQueueService: ChatQueueService | undefined
    const sessionExtensionServices: BuddySessionExtensionServices = {
      followUp: async (runId, signal) => { await chatQueueService?.followUp(runId, signal) },
      prepareForRun: signal => connectorService.prepareForRun(signal),
      shellSandbox: await host.start('runtime.shell_sandbox', ({ defer }) => {
        const sandbox = new ShellSandboxClient(options.rpc)
        defer(() => sandbox.dispose())
        return sandbox
      }),
      approvalService,
      attachmentService,
      changeCaptureService,
      directoryGrants,
      createCapabilities: createBuddyCapabilityFactory(currentPlatform, {
        pluginAuthoring: options.rpc,
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
        onAutomationChanged: automationId => automationChanges.publish(automationId),
        webService,
      }, {
        eventSink: event => options.eventLog.append(event),
        peer: options.rpc,
      }),
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
    const conversationTree = new BuddyConversationTree({ conversationsDirectory: paths.conversationsDirectory, conversations, repository: createConversationTreeRepository(options.database), runs, recovery: sessionRecovery })
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
      runs,
      sessionFactory: input => sessionFactory.create(input),
      sessions,
    })
    runner = await host.start('runtime.execution', ({ defer }) => {
      const service = new BuddyAgentRunner({
        executor: piTurnExecutor,
        lifecycle: runLifecycleService,
        onRunSettled: (runId) => {
          approvalService.clearRunAuthorizations(runId)
          chatQueueService?.onRunSettled(runId)
        },
        sessions,
      })
      defer(async () => {
        await service.dispose()
        await automationScheduler?.settle()
      })
      return service
    })
    const conversationLifecycle = new ConversationLifecycleService({
      conversations,
      directoryGrants: conversationDirectoryGrants,
      runner,
      sessions,
    })
    const automationOccurrenceLifecycle = new AutomationOccurrenceLifecycleService({
      automations: automationService,
      conversationLifecycle,
      notifications: notificationService,
      onChanged: automationId => automationChanges.publish(automationId),
    })
    const executionPlanner = new BuddyRunExecutionPlanner({
      attachments: attachmentService,
      commands: commandRequests,
      conversations,
      models: executionModels,
      runInputs,
      runs,
      sessions: sessionBlueprints,
    })
    const turnLauncher = new BuddyTurnLauncher({
      lifecycle: runLifecycleService,
      planner: executionPlanner,
      runner,
    })
    const chatCommandService = new ChatCommandService({
      commands: commandRequests,
      conversationLifecycle,
      conversations,
      drafts: composerDrafts,
      spaces: spacesRepository,
      runs,
      turnLauncher,
    })
    const composerDraftService = new ComposerDraftService(composerDrafts, draftId => composerResourceService.discard(draftId))
    const chatTurnService = new ChatTurnService({
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
      record,
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
    chatQueueService = await host.start('runtime.chat-queue', ({ defer }) => {
      const service = new ChatQueueService({ queue: createChatQueueRepository(options.database), turns: chatTurnService, requests: turnRequests, launcher: turnLauncher, runner, runs, runInputs })
      defer(() => service.dispose())
      return service
    })
    const runtime: BuddyRuntime = {
      startTurn: input => chatTurnService.start(input),
    }
    const contextUsageService = new ContextUsageSnapshotService({
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
    const automationDispatcher = new AutomationDispatcher(automationService, new AgentTaskAutomationAction({
      automationService,
      cancelRun: (runId, errorCode) => runner.cancel(runId, errorCode),
      clock: automationClock,
      launchTurn: runId => turnLauncher.launch(runId),
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
    }))
    const scheduler = new AutomationScheduler({
      automationService,
      clock: automationClock,
      dispatch: async (occurrence) => {
        await events.scope({ component: 'runtime.automations', automationId: occurrence.automationId, occurrenceId: occurrence.id }).operation('automation.dispatch', () => automationDispatcher.dispatch(occurrence))
        automationChanges.publishSchedulerChange(occurrence.automationId)
      },
      onChanged: automationId => automationChanges.publishSchedulerChange(automationId),
    })
    automationScheduler = scheduler

    await host.step('runtime.recovery', async () => {
      await conversationLifecycle.recoverPendingDeletions()
      const count = await runRecoveryService.recoverInterruptedRuns()
      record({ event: 'runtime.runs_recovered', level: 'info', count })
      await options.eventLog.compactTerminalRuns()
    })

    await host.start('runtime.rpc', ({ defer }) => {
      const register = (dispose: () => void) => defer(dispose)
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
          normalize: value => normalizeComposerWorkspace(value, { conversations, resources: composerResourceService }),
          repository: workspace,
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
      register(registerTaskMarkRpc(options.rpc, createTaskMarkRepository(options.database)))
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
          deleteConversation: async (conversationId) => {
            const result = await automationOccurrenceLifecycle.deleteConversation(conversationId)
            return result.deleted
          },
          eventLog: options.eventLog,
          isDeleting: conversationId => conversationLifecycle.isDeleting(conversationId),
          resolveModelSelection: selection => resolveInteractiveModelSelection(
            providerService,
            selection,
          ),
          rpc: options.rpc,
          runInputs,
          runs,
          sessions,
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
          automations: automationChanges,
          spaces: spacesRepository,
          rpc: options.rpc,
          service: spaceService,
          sessions,
        }),
      )
      register(registerSpaceFileRpc(options.rpc, spacesRepository))
      register(
        registerProviderRpc({
          automations: automationChanges,
          rpc: options.rpc,
          service: providerService,
          sessions,
        }),
      )
      register(
        registerSkillServiceRpc(options.rpc, skillService),
      )
    })
    await host.start('runtime.scheduler', ({ defer }) => {
      defer(() => scheduler.dispose())
      return scheduler.start()
    }, ['runtime.rpc', 'runtime.execution'])
    return { dispose: () => host.stop(), runtime }
  }
  catch (error) {
    try {
      await host.stop()
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime initialization and cleanup failed')
    }
    throw error
  }
}

function requireValue<T>(value: T | null, code: BuddyServiceErrorCode): T {
  if (value === null)
    throw new BuddyServiceError(code)
  return value
}
