import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddySettings } from '../../../../shared/buddies/buddySettings'
import type { BuddyUserMessageContentV1 } from '../../../../shared/conversation/buddyUserContent'
import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'
import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { ImagePreferences } from '../../../../shared/images/imagePreferences'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { BuddySessionMode } from '../../../../shared/permissions/sessionMode'
import type { ApprovalService } from '../../approvals/ApprovalService'
import type { BuddyToolClassificationResult } from '../../approvals/toolClassification'
import type { AttachmentService } from '../../attachments/AttachmentService'
import type { ImageBlobStore } from '../../attachments/ImageBlobStore'
import type { ChangeCaptureService } from '../../changes/ChangeCaptureService'
import type { MutationCoordinator } from '../../changes/MutationCoordinator'
import type { DirectoryGrantService } from '../../directories/DirectoryGrantService'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { FileResourceCoordinator } from '../../files/FileResourceCoordinator'
import type { ImageReadingMaterialWriter } from '../../images/ImageReadingMaterialStore'
import type { ImageReadingService } from '../../images/ImageReadingService'
import type { NetworkPermissionsStore } from '../../permissions/NetworkPermissionsClient'
import type { ShellSandboxClient } from '../../sandbox/ShellSandboxClient'
import type { ExtensionShellRegistry } from '../../sandbox/ShellSelection'
import type { BuddyInputReferenceStore } from '../context/BuddyInputReference'
import type { ExecutionDelegationService } from '../execution/ExecutionDelegationService'
import type { BuddyCapability, BuddyCapabilityFactory, BuddyCapabilityResourceRevision } from './BuddyCapability'
import type { BuddyExtensionRunContext, BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import type { BuddyToolExposureResolver } from './discovery/toolDiscoveryContract'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { createCapturedFileWriter } from '../../changes/CapturedFileWriter'
import { SessionDirectoryGrants } from '../../directories/SessionDirectoryGrants'
import { createImageReadingCapability } from '../../images/imageReadingExtension'
import { observeSessionPermissions } from '../../permissions/observeSessionPermissions'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { ToolExecutionPermissions } from '../../permissions/ToolExecutionPermissions'
import { SandboxDirectoryPermissions } from '../../sandbox/SandboxDirectoryPermissions'
import { createShellCapability } from '../../sandbox/shellCapability'
import { resolveShellExecution } from '../../sandbox/shellExecution'
import { createMutationToolWrapper } from './changeCaptureExtension'
import { createChatQueueExtension } from './chatQueueExtension'
import { createCodemodeCapability } from './codemodeExtension'
import { createCompactionTimingExtension } from './compactionTimingExtension'
import { createDelegationCapability } from './delegationCapability'
import { observeSessionTools } from './discovery/observeSessionTools'
import { SessionToolCapabilities } from './discovery/SessionToolCapabilities'
import { SessionToolScope } from './discovery/SessionToolScope'
import { createToolDiscoveryCapability } from './discovery/toolDiscoveryExtension'
import { createFileMutationExtension } from './fileMutationExtension'
import { createInputReferenceExtension } from './inputReferenceExtension'
import { createModelSwitchExtension } from './modelSwitchExtension'
import { createToolPolicyExtension } from './toolPolicyExtension'

export interface BuddySessionExtensionServices {
  getInputProjection?: (conversationId: string, messageId: string) => Pick<BuddyUserMessageContentV1, 'materialProjection' | 'resourceSnapshots'> | null
  networkPermissions?: NetworkPermissionsStore
  imageReading?: Pick<ImageReadingService, 'read' | 'allowsNativeInput'>
  getImagePreferences?: (signal: AbortSignal) => Promise<ImagePreferences>
  delegation?: Pick<ExecutionDelegationService, 'execute' | 'pending' | 'assertShellExecutionAllowed'>
  followUp?: (runId: string, signal: AbortSignal) => Promise<void>
  prepareForRun?: (signal: AbortSignal) => Promise<void>
  approvalService: Pick<ApprovalService, 'request'> & Partial<Pick<ApprovalService, 'clearRunAuthorizations'>>
  attachmentService: Pick<AttachmentService, 'prepareInputImages' | 'materializeDocumentInputs' | 'materializeInputResources' | 'getInputMetadata'>
  changeCaptureService: Pick<ChangeCaptureService, 'beginInvocation' | 'finishInvocation' | 'markPartial'>
  fileResources: FileResourceCoordinator
  mutations: MutationCoordinator
  receiptDirectory?: string
  createCapabilities: BuddyCapabilityFactory
  directoryGrants: Pick<DirectoryGrantService, 'grant' | 'assertCurrent'>
  recordPermissions?: ApplicationDiagnosticReporter
  resolveToolExposure?: BuddyToolExposureResolver
  shellSandbox?: Pick<ShellSandboxClient, 'exec'>
  shells?: Pick<ExtensionShellRegistry, 'snapshot'>
}

export interface CreateBuddySessionExtensionsOptions {
  imageStore?: ImageBlobStore
  writeImageMaterial?: ImageReadingMaterialWriter
  actorKind?: 'actor' | 'npc'
  approvalPolicy: BuddyApprovalPolicy
  canonicalRoot: string
  conversationId: string
  executionProfile: BuddyExecutionProfile
  toolScope?: BuddySettings['tools']
  fileAccessLimit?: BuddySettings['limits']['fileAccess']
  grants: readonly DirectoryGrant[]
  skillReadRoots?: readonly string[]
  sessionMode: BuddySessionMode
  signal: AbortSignal
  spaceId: string | null
  services: BuddySessionExtensionServices
}

export interface BuddySessionExtensions {
  getPermissionSettings: () => BuddyPermissionSettings
  updatePermissionSettings: (settings: BuddyPermissionSettings) => void
  setCodemodeEnabled: (enabled: boolean) => void
  assertCodemodeReady: () => void
  toolCapabilities: Pick<SessionToolCapabilities, 'onDidChange' | 'snapshot'>
  dispose: () => Promise<void>
  resourceRevisions: readonly BuddyCapabilityResourceRevision[]
  getServiceTier: () => BuddyServiceTier | null
  inputReferences: BuddyInputReferenceStore
  inProcessExtensions: readonly BuddyInProcessExtension[]
  runContext: BuddyExtensionRunContextStore
}

export async function createBuddySessionExtensions(
  options: CreateBuddySessionExtensionsOptions,
): Promise<BuddySessionExtensions> {
  const { services } = options
  const creationSignal = options.signal
  const lifetime = new AbortController()
  const cancelCreation = () => lifetime.abort(creationSignal.reason)
  const grants = new SessionDirectoryGrants(options.grants)
  const sandboxDirectories = new SandboxDirectoryPermissions()
  const runContext: BuddyExtensionRunContextStore = { current: null }
  let permissionSettings: BuddyPermissionSettings = { approvalPolicy: options.approvalPolicy, executionProfile: options.executionProfile }
  let codemodeEnabled = false
  const codemode = createCodemodeCapability(() => codemodeEnabled)
  const fileAccessLimit = options.fileAccessLimit ?? 'inherit'
  const getExecutionProfile = () => fileAccessLimit === 'read_only' ? 'read_only' : permissionSettings.executionProfile
  const inputReferences: BuddyInputReferenceStore = { pending: null }
  const executionPermissions = new ToolExecutionPermissions()
  const diagnostics = observeSessionPermissions({ grants: grants.onDidChange, sandbox: sandboxDirectories.onDidChange, tools: executionPermissions.onDidChange }, options.conversationId, services.recordPermissions)
  let toolCapabilities: SessionToolCapabilities | undefined
  let toolScope: SessionToolScope | undefined
  let stopToolDiagnostics: { dispose: () => void } | undefined
  const capabilities: BuddyCapability[] = []
  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposing)
      return disposing
    const completion = Promise.withResolvers<void>()
    disposing = completion.promise
    creationSignal.removeEventListener('abort', cancelCreation)
    lifetime.abort()
    toolCapabilities?.dispose()
    void Promise.allSettled(capabilities.map(async capability => capability.dispose?.())).then((results) => {
      stopToolDiagnostics?.dispose()
      grants.dispose()
      sandboxDirectories.dispose()
      executionPermissions.dispose()
      diagnostics.dispose()
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError(failures.map(result => result.reason), 'SESSION_CAPABILITY_CLEANUP_FAILED')
    }).then(completion.resolve, completion.reject)
    return disposing
  }
  try {
    creationSignal.addEventListener('abort', cancelCreation, { once: true })
    creationSignal.throwIfAborted()
    const authorization = new ToolAuthorizationService({
      networkPermissions: services.networkPermissions,
      applySandboxDirectory: (run, grant) => sandboxDirectories.grant(run, grant),
      getSandboxDirectories: run => sandboxDirectories.get(run),
      applyGrant: async (proposal) => {
        const mutation = await services.directoryGrants.grant(proposal)
        services.directoryGrants.assertCurrent(proposal.owner, mutation.grant.id)
        grants.apply(mutation)
      },
      approvalAvailable: options.sessionMode === 'interactive',
      approvalPolicy: options.approvalPolicy,
      approvalService: services.approvalService,
      cwd: options.canonicalRoot,
      executionPermissions,
      get executionProfile() { return getExecutionProfile() },
      fileAccessLimit,
      getToolScopeDenial: toolName => toolScope ? toolScope.denial(toolName) : 'TOOL_SCOPE_UNAVAILABLE',
      getGrants: () => grants.snapshot,
      owner: options.spaceId
        ? { id: options.spaceId, kind: 'space' }
        : { id: options.conversationId, kind: 'conversation' },
    })
    capabilities.push(codemode, ...await services.createCapabilities({
      createFileWriter: (event) => {
        const run = runContext.current
        if (!run)
          throw new Error('RUN_CONTEXT_UNAVAILABLE')
        return createCapturedFileWriter({ conversationId: options.conversationId, cwd: options.canonicalRoot, run, event, authorization, mutations: services.mutations, changes: services.changeCaptureService, getGrants: () => [...grants.snapshot, ...executionPermissions.get(run, event.toolCallId)] })
      },
      authorizeNetwork: async (input) => {
        const run = runContext.current
        if (!run)
          throw Object.assign(new Error('RUN_CONTEXT_UNAVAILABLE'), { toolCallBlockReason: 'RUN_CONTEXT_UNAVAILABLE' })
        const url = new URL(input.url)
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
          throw Object.assign(new Error('NETWORK_TARGET_INVALID'), { toolCallBlockReason: 'NETWORK_TARGET_INVALID' })
        const denial = await authorization.authorize({
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: { url: input.url },
        }, run, { access: 'network', paths: [] }, {
          network: { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)) },
          networkOperation: input.operation,
          signal: input.signal,
        })
        if (denial)
          throw Object.assign(new Error(denial), { toolCallBlockReason: denial })
      },
      isCodemodeEnabled: () => codemodeEnabled,
      conversationId: options.conversationId,
      get executionProfile() { return getExecutionProfile() },
      cwd: options.canonicalRoot,
      getRunId: () => runContext.current?.runId,
      getImagePreferences: () => runContext.current?.imagePreferences,
      getExecutionGrants: toolCallId => [...grants.snapshot, ...executionPermissions.get(runContext.current, toolCallId)],
      get grants() { return grants.snapshot },
      sessionMode: options.sessionMode,
      signal: lifetime.signal,
    }))
    if (services.imageReading && options.imageStore && options.writeImageMaterial) {
      capabilities.push(createImageReadingCapability({
        cwd: options.canonicalRoot,
        store: options.imageStore,
        writeMaterial: options.writeImageMaterial,
        readImage: input => services.imageReading!.read({ ...input, runId: runContext.current?.runId, preferences: runContext.current?.imagePreferences }),
        getGrants: toolCallId => [...grants.snapshot, ...executionPermissions.get(runContext.current, toolCallId)],
      }))
    }
    const shells = await services.shells?.snapshot(lifetime.signal)
    const shellCapability = createShellCapability({
      shells,
      cwd: options.canonicalRoot,
      execution: resolveShellExecution(getExecutionProfile()),
      getExecution: () => resolveShellExecution(getExecutionProfile()),
      getGrants: () => grants.snapshot,
      resourceReadRoots: options.skillReadRoots ?? [],
      getRunContext: () => runContext.current,
      authorization,
      sandbox: services.shellSandbox,
      directoryPermissions: sandboxDirectories,
      mutations: services.mutations,
      receiptDirectory: services.receiptDirectory,
      assertExecutionAllowed: ({ run }) => services.delegation?.assertShellExecutionAllowed(run.runId),
    })
    capabilities.push(shellCapability)
    if (services.delegation) {
      capabilities.push(createDelegationCapability({
        service: services.delegation,
        runContext,
        actorKind: options.actorKind ?? 'actor',
        getPermissions: () => ({ ...permissionSettings, executionProfile: getExecutionProfile() }),
      }))
    }
    creationSignal.throwIfAborted()
    const resourceRevisions = copyEventSnapshot(capabilities.flatMap(capability => capability.resourceRevisions ?? []))
    const disclosurePolicies = capabilities.flatMap(capability => capability.disclosure ?? [])
    toolScope = new SessionToolScope(disclosurePolicies, options.toolScope, fileAccessLimit)
    const scope = toolScope
    toolCapabilities = new SessionToolCapabilities(resourceRevisions, services.resolveToolExposure, scope)
    stopToolDiagnostics = observeSessionTools(toolCapabilities, options.conversationId, () => runContext.current?.runId, services.recordPermissions)
    const discovery = createToolDiscoveryCapability(disclosurePolicies, toolCapabilities)
    const sessionCapabilities = [...capabilities, discovery]
    const classifyTool = async (event: ToolCallEvent, run: BuddyExtensionRunContext): Promise<BuddyToolClassificationResult> => {
      for (const capability of sessionCapabilities) {
        const classification = await capability.classify(event, run.signal)
        if (classification)
          return classification
      }
      return {}
    }
    const wrapTool = createMutationToolWrapper({
      conversationId: options.conversationId,
      cwd: options.canonicalRoot,
      authorization,
      changes: services.changeCaptureService,
      mutations: services.mutations,
      getRunContext: () => runContext.current,
      getGrants: (run, toolCallId) => [...grants.snapshot, ...executionPermissions.get(run, toolCallId)],
      getWorkspaceGrants: run => [...grants.snapshot, ...sandboxDirectories.getWriteGrants(run)],
      classify: classifyTool,
      mutationEffect: (event, classification) => {
        for (const capability of sessionCapabilities) {
          const effect = capability.mutationEffect?.(event, classification)
          if (effect)
            return effect
        }
        return null
      },
      workspaceMutationTools: capabilities.flatMap(capability => capability.workspaceMutationTools ?? []),
    })
    const inProcessExtensions: BuddyInProcessExtension[] = [
      createCompactionTimingExtension(),
      createModelSwitchExtension(runContext),
      createInputReferenceExtension(inputReferences),
      ...options.sessionMode === 'interactive' && services.followUp
        ? [createChatQueueExtension({ getRunContext: () => runContext.current, followUp: services.followUp })]
        : [],
      scope.wrap(createFileMutationExtension(options.canonicalRoot, services.fileResources, services.mutations), wrapTool),
      ...capabilities.map(capability => scope.wrap(capability.extension, wrapTool)),
      { ...discovery.extension, factory: (pi) => {
        scope.assertRegistered()
        return discovery.extension.factory(pi)
      } },
      createToolPolicyExtension({
        authorization,
        classifyTool,
        getRunContext: () => runContext.current,
      }),
    ]

    return {
      getPermissionSettings: () => ({ ...permissionSettings, executionProfile: getExecutionProfile() }),
      updatePermissionSettings: (settings) => {
        if (settings.approvalPolicy === permissionSettings.approvalPolicy && settings.executionProfile === permissionSettings.executionProfile)
          return
        permissionSettings = { ...settings }
        if (runContext.current) {
          services.approvalService.clearRunAuthorizations?.(runContext.current.runId, 'permissions_changed')
          sandboxDirectories.clear(runContext.current)
        }
        authorization.updatePermissionSettings(settings)
        shellCapability.refreshExecution()
      },
      setCodemodeEnabled: enabled => codemodeEnabled = enabled,
      assertCodemodeReady: codemode.assertReady,
      dispose,
      resourceRevisions,
      toolCapabilities,
      getServiceTier: () => runContext.current?.serviceTier ?? null,
      inputReferences,
      inProcessExtensions,
      runContext,
    }
  }
  catch (error) {
    try {
      await dispose()
    }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SESSION_EXTENSION_INITIALIZATION_FAILED') }
    throw error
  }
  finally {
    creationSignal.removeEventListener('abort', cancelCreation)
  }
}
