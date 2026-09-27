import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddySessionMode } from '../../../../shared/permissions/sessionMode'
import type { ApprovalService } from '../../approvals/ApprovalService'
import type { AttachmentService } from '../../attachments/AttachmentService'
import type { ChangeCaptureService } from '../../changes/ChangeCaptureService'
import type { DirectoryGrantMutation, DirectoryGrantService } from '../../directories/DirectoryGrantService'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ShellSandboxClient } from '../../sandbox/ShellSandboxClient'
import type { BuddyInputReferenceStore } from '../context/BuddyInputReference'
import type { BuddyCapabilityFactory } from './BuddyCapability'
import type { BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { ToolExecutionPermissions } from '../../permissions/ToolExecutionPermissions'
import { SandboxDirectoryPermissions } from '../../sandbox/SandboxDirectoryPermissions'
import { createShellCapability } from '../../sandbox/shellCapability'
import { resolveShellExecution } from '../../sandbox/shellExecution'
import { createChangeCaptureExtension } from './changeCaptureExtension'
import { createChatQueueExtension } from './chatQueueExtension'
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
  directoryGrants: Pick<DirectoryGrantService, 'grant'>
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
  getServiceTier: () => BuddyServiceTier | null
  inputReferences: BuddyInputReferenceStore
  inProcessExtensions: readonly BuddyInProcessExtension[]
  runContext: BuddyExtensionRunContextStore
}

export async function createBuddySessionExtensions(
  options: CreateBuddySessionExtensionsOptions,
): Promise<BuddySessionExtensions> {
  const { services } = options
  const grants = [...options.grants]
  const sandboxDirectories = new SandboxDirectoryPermissions()
  const runContext: BuddyExtensionRunContextStore = { current: null }
  const inputReferences: BuddyInputReferenceStore = { pending: null }
  const executionPermissions = new ToolExecutionPermissions()
  const authorization = new ToolAuthorizationService({
    applySandboxDirectory: (run, grant) => sandboxDirectories.grant(run, grant),
    applyGrant: async proposal => applyGrantToSession(grants, await services.directoryGrants.grant(proposal)),
    approvalAvailable: options.sessionMode === 'interactive',
    approvalPolicy: options.approvalPolicy,
    approvalService: services.approvalService,
    cwd: options.canonicalRoot,
    executionPermissions,
    executionProfile: options.executionProfile,
    getGrants: () => grants,
    owner: options.spaceId
      ? { id: options.spaceId, kind: 'space' }
      : { id: options.conversationId, kind: 'conversation' },
  })
  const capabilities = [...await services.createCapabilities({
    conversationId: options.conversationId,
    executionProfile: options.executionProfile,
    cwd: options.canonicalRoot,
    getRunId: () => runContext.current?.runId,
    getExecutionGrants: toolCallId => [...grants, ...executionPermissions.get(runContext.current, toolCallId)],
    grants,
    sessionMode: options.sessionMode,
    signal: options.signal,
  })]
  const execution = resolveShellExecution(options.executionProfile)
  if (execution.boundary === 'sandbox') {
    capabilities.push(createShellCapability({
      cwd: options.canonicalRoot,
      execution,
      getGrants: () => grants,
      resourceReadRoots: options.skillReadRoots ?? [],
      getRunContext: () => runContext.current,
      authorization,
      sandbox: services.shellSandbox,
      directoryPermissions: sandboxDirectories,
    }))
  }
  options.signal.throwIfAborted()
  const discovery = createToolDiscoveryCapability(capabilities.flatMap(capability => capability.disclosure ? [capability.disclosure] : []))
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
      grants,
      getWorkspaceGrants: () => [...grants, ...sandboxDirectories.getWriteGrants(runContext.current)],
      service: services.changeCaptureService,
      workspaceMutationTools: capabilities.flatMap(capability => capability.workspaceMutationTools ?? []),
    }),
  ]

  return {
    getServiceTier: () => runContext.current?.serviceTier ?? null,
    inputReferences,
    inProcessExtensions,
    runContext,
  }
}

function applyGrantToSession(grants: DirectoryGrant[], mutation: DirectoryGrantMutation): void {
  const covered = new Set(mutation.coveredGrantIds)
  for (let index = grants.length - 1; index >= 0; index -= 1) {
    if (covered.has(grants[index]!.grantId))
      grants.splice(index, 1)
  }
  if (grants.some(grant => grant.grantId === mutation.grant.id))
    return
  grants.push({
    canonicalRoot: mutation.grant.canonicalRoot,
    grantId: mutation.grant.id,
    kind: 'granted',
    root: mutation.grant.root,
  })
}
