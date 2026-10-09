import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'
import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddySessionMode } from '../../../../shared/permissions/sessionMode'
import type { ApprovalService } from '../../approvals/ApprovalService'
import type { AttachmentService } from '../../attachments/AttachmentService'
import type { ChangeCaptureService } from '../../changes/ChangeCaptureService'
import type { DirectoryGrantService } from '../../directories/DirectoryGrantService'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ShellSandboxClient } from '../../sandbox/ShellSandboxClient'
import type { BuddyInputReferenceStore } from '../context/BuddyInputReference'
import type { BuddyCapability, BuddyCapabilityFactory, BuddyCapabilityResourceRevision } from './BuddyCapability'
import type { BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import type { BuddyToolExposureResolver } from './discovery/toolDiscoveryContract'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { SessionDirectoryGrants } from '../../directories/SessionDirectoryGrants'
import { observeSessionPermissions } from '../../permissions/observeSessionPermissions'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { ToolExecutionPermissions } from '../../permissions/ToolExecutionPermissions'
import { SandboxDirectoryPermissions } from '../../sandbox/SandboxDirectoryPermissions'
import { createShellCapability } from '../../sandbox/shellCapability'
import { resolveShellExecution } from '../../sandbox/shellExecution'
import { createChangeCaptureExtension } from './changeCaptureExtension'
import { createChatQueueExtension } from './chatQueueExtension'
import { createCodemodeCapability } from './codemodeExtension'
import { observeSessionTools } from './discovery/observeSessionTools'
import { SessionToolCapabilities } from './discovery/SessionToolCapabilities'
import { createToolDiscoveryCapability } from './discovery/toolDiscoveryExtension'
import { createInputReferenceExtension } from './inputReferenceExtension'
import { createToolPolicyExtension } from './toolPolicyExtension'

export interface BuddySessionExtensionServices {
  followUp?: (runId: string, signal: AbortSignal) => Promise<void>
  prepareForRun?: (signal: AbortSignal) => Promise<void>
  approvalService: Pick<ApprovalService, 'request'>
  attachmentService: Pick<AttachmentService, 'prepareInputImages' | 'materializeDocumentInputs' | 'materializeInputResources' | 'getInputMetadata'>
  changeCaptureService: Pick<ChangeCaptureService, 'beginFileTool' | 'beginWorkspaceTool' | 'finalizeRun' | 'finishFileTool' | 'finishWorkspaceTool' | 'markPartial'>
  createCapabilities: BuddyCapabilityFactory
  directoryGrants: Pick<DirectoryGrantService, 'grant' | 'assertCurrent'>
  recordPermissions?: ApplicationDiagnosticReporter
  resolveToolExposure?: BuddyToolExposureResolver
  shellSandbox?: Pick<ShellSandboxClient, 'exec'>
}

export interface CreateBuddySessionExtensionsOptions {
  approvalPolicy: BuddyApprovalPolicy
  canonicalRoot: string
  conversationId: string
  executionProfile: BuddyExecutionProfile
  grants: readonly DirectoryGrant[]
  skillReadRoots?: readonly string[]
  sessionMode: BuddySessionMode
  signal: AbortSignal
  spaceId: string | null
  services: BuddySessionExtensionServices
}

export interface BuddySessionExtensions {
  setCodemodeEnabled: (enabled: boolean) => void
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
  let codemodeEnabled = false
  const inputReferences: BuddyInputReferenceStore = { pending: null }
  const executionPermissions = new ToolExecutionPermissions()
  const diagnostics = observeSessionPermissions({ grants: grants.onDidChange, sandbox: sandboxDirectories.onDidChange, tools: executionPermissions.onDidChange }, options.conversationId, services.recordPermissions)
  let toolCapabilities: SessionToolCapabilities | undefined
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
      applySandboxDirectory: (run, grant) => sandboxDirectories.grant(run, grant),
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
      executionProfile: options.executionProfile,
      getGrants: () => grants.snapshot,
      owner: options.spaceId
        ? { id: options.spaceId, kind: 'space' }
        : { id: options.conversationId, kind: 'conversation' },
    })
    capabilities.push(createCodemodeCapability(() => codemodeEnabled), ...await services.createCapabilities({
      isCodemodeEnabled: () => codemodeEnabled,
      conversationId: options.conversationId,
      executionProfile: options.executionProfile,
      cwd: options.canonicalRoot,
      getRunId: () => runContext.current?.runId,
      getExecutionGrants: toolCallId => [...grants.snapshot, ...executionPermissions.get(runContext.current, toolCallId)],
      get grants() { return grants.snapshot },
      sessionMode: options.sessionMode,
      signal: lifetime.signal,
    }))
    const execution = resolveShellExecution(options.executionProfile)
    if (execution.boundary === 'sandbox') {
      capabilities.push(createShellCapability({
        cwd: options.canonicalRoot,
        execution,
        getGrants: () => grants.snapshot,
        resourceReadRoots: options.skillReadRoots ?? [],
        getRunContext: () => runContext.current,
        authorization,
        sandbox: services.shellSandbox,
        directoryPermissions: sandboxDirectories,
      }))
    }
    creationSignal.throwIfAborted()
    const resourceRevisions = copyEventSnapshot(capabilities.flatMap(capability => capability.resourceRevisions ?? []))
    toolCapabilities = new SessionToolCapabilities(resourceRevisions, services.resolveToolExposure)
    stopToolDiagnostics = observeSessionTools(toolCapabilities, options.conversationId, () => runContext.current?.runId, services.recordPermissions)
    const discovery = createToolDiscoveryCapability(capabilities.flatMap(capability => capability.disclosure ?? []), toolCapabilities)
    const sessionCapabilities = [...capabilities, discovery]
    const inProcessExtensions: BuddyInProcessExtension[] = [
      createInputReferenceExtension(inputReferences),
      ...options.sessionMode === 'interactive' && services.followUp
        ? [createChatQueueExtension({ getRunContext: () => runContext.current, followUp: services.followUp })]
        : [],
      ...sessionCapabilities.map(capability => capability.extension),
      createToolPolicyExtension({
        authorization,
        classifyTool: async (event, run) => {
          for (const capability of sessionCapabilities) {
            const classification = await capability.classify(event, run.signal)
            if (classification)
              return classification
          }
          return {}
        },
        getRunContext: () => runContext.current,
      }),
      createChangeCaptureExtension({
        conversationId: options.conversationId,
        cwd: options.canonicalRoot,
        getRunContext: () => runContext.current,
        get grants() { return grants.snapshot },
        getWorkspaceGrants: () => [...grants.snapshot, ...sandboxDirectories.getWriteGrants(runContext.current)],
        service: services.changeCaptureService,
        workspaceMutationTools: capabilities.flatMap(capability => capability.workspaceMutationTools ?? []),
      }),
    ]

    return {
      setCodemodeEnabled: enabled => codemodeEnabled = enabled,
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
