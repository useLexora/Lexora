import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { PathApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { SandboxDirectoryGrant, SandboxNetworkTarget } from '../../../shared/permissions/shellSandbox'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { ApprovalService } from '../approvals/ApprovalService'
import type { BuddyToolClassification } from '../approvals/toolClassification'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { GrantOwner, GrantProposal, PermissionDecision } from './permissionContract'
import type { ToolExecutionPermissions } from './ToolExecutionPermissions'
import { PathClassificationError } from './classifyPath'
import { PermissionEngine } from './PermissionEngine'

export interface ToolAuthorizationOptions {
  approvalService: Pick<ApprovalService, 'request'>
  approvalAvailable: boolean
  approvalPolicy: BuddyApprovalPolicy
  executionProfile: BuddyExecutionProfile
  cwd: string
  owner: GrantOwner
  getGrants: () => readonly DirectoryGrant[]
  applyGrant?: (grant: GrantProposal) => Promise<void> | void
  applySandboxDirectory?: (run: BuddyExtensionRunContext, grant: SandboxDirectoryGrant) => Promise<void>
  executionPermissions?: ToolExecutionPermissions
  engine?: PermissionEngine
}

export interface ToolAuthorizationCall {
  input: unknown
  toolCallId: string
  toolName: string
}

export class ToolAuthorizationService {
  readonly #options: ToolAuthorizationOptions
  readonly #engine: PermissionEngine

  constructor(options: ToolAuthorizationOptions) {
    this.#options = options
    this.#engine = options.engine ?? new PermissionEngine()
  }

  async authorize(
    event: ToolAuthorizationCall,
    run: BuddyExtensionRunContext,
    declared: BuddyToolClassification = {},
    resource: { network?: SandboxNetworkTarget, signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const options = this.#options
    let authorized = false
    options.executionPermissions?.release(run, event.toolCallId)
    try {
      const signal = resource.signal ? AbortSignal.any([resource.signal, run.signal]) : run.signal
      signal.throwIfAborted()
      await run.flushProjectedEvents()
      const decision = await this.#engine.decide({
        access: declared.access,
        approvalAvailable: options.approvalAvailable,
        approvalPolicy: options.approvalPolicy,
        approval: declared.approval,
        arguments: event.input,
        cwd: options.cwd,
        forceAsk: declared.forceAsk,
        requireApproval: declared.requireApproval,
        shellBoundary: declared.shellBoundary,
        grants: options.getGrants(),
        owner: options.owner,
        paths: declared.paths,
        profile: options.executionProfile,
        toolName: event.toolName,
      })
      if (decision.type === 'deny')
        return decision.code

      let approvedOnce = false
      if (decision.type === 'ask') {
        const approval = await options.approvalService.request({
          arguments: event.input,
          automation: declared.approval?.automation,
          browser: declared.approval?.browser,
          cwd: options.cwd,
          kind: decision.kind,
          network: resource.network,
          paths: declared.approval?.paths ?? toPathReview(decision),
          reuse: declared.approval?.reuse,
          runId: run.runId,
          runSignal: run.signal,
          signal,
          shell: decision.shell,
          sandboxDirectory: decision.sandboxDirectory
            ? { path: decision.sandboxDirectory.path, access: decision.sandboxDirectory.access, reason: decision.sandboxDirectory.reason }
            : undefined,
          summary: decision.summary,
          systemAction: declared.approval?.systemAction,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        })
        if (approval.decision === 'denied')
          return 'APPROVAL_DENIED'
        approvedOnce = approval.decision === 'approved_once'
      }
      signal.throwIfAborted()
      const validation = await declared.validateBeforeExecution?.()
      if (validation)
        return validation.reason
      if (!resource.network && declared.paths?.length) {
        try {
          await options.executionPermissions?.authorize(run, event.toolCallId, {
            cwd: options.cwd,
            grants: options.getGrants(),
            paths: declared.paths,
            reviewedPaths: decision.type === 'ask' ? decision.paths : undefined,
          })
        }
        catch (error) {
          if (error instanceof PathClassificationError)
            return error.code
          throw error
        }
      }
      if (decision.type === 'ask') {
        signal.throwIfAborted()
        if (decision.sandboxDirectory) {
          if (!options.applySandboxDirectory)
            return 'DIRECTORY_GRANT_FAILED'
          try {
            await options.applySandboxDirectory(run, decision.sandboxDirectory)
          }
          catch {
            return 'SANDBOX_DIRECTORY_CHANGED'
          }
        }
        if (decision.grant && approvedOnce) {
          try {
            if (!options.applyGrant)
              return 'DIRECTORY_GRANT_FAILED'
            await options.applyGrant(decision.grant)
          }
          catch {
            return 'DIRECTORY_GRANT_FAILED'
          }
        }
      }
      signal.throwIfAborted()
      authorized = true
      return null
    }
    finally {
      if (!authorized)
        options.executionPermissions?.release(run, event.toolCallId)
    }
  }
}

function toPathReview(decision: Extract<PermissionDecision, { type: 'ask' }>): PathApprovalReviewInput | undefined {
  if (!decision.paths?.length || !['delete', 'read', 'render', 'write'].includes(decision.kind))
    return undefined
  return {
    access: decision.kind as PathApprovalReviewInput['access'],
    grant: decision.grant ? { owner: decision.grant.owner.kind, root: decision.grant.root } : null,
    targets: [...decision.paths],
  }
}
