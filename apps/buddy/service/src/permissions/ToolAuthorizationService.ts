import type { BuddySettings } from '../../../shared/buddies/buddySettings'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { PathApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { BuddyPermissionSettings } from '../../../shared/permissions/permissionMode'
import type { SandboxDirectoryGrant, SandboxNetworkTarget } from '../../../shared/permissions/shellSandbox'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { ApprovalService } from '../approvals/ApprovalService'
import type { BuddyToolClassification } from '../approvals/toolClassification'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { GrantOwner, GrantProposal, PermissionDecision } from './permissionContract'
import type { ToolExecutionPermissions } from './ToolExecutionPermissions'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
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
  getSandboxDirectories?: (run: BuddyExtensionRunContext) => readonly SandboxDirectoryGrant[]
  applyGrant?: (grant: GrantProposal) => Promise<void> | void
  applySandboxDirectory?: (run: BuddyExtensionRunContext, grant: SandboxDirectoryGrant) => Promise<void>
  executionPermissions?: ToolExecutionPermissions
  engine?: PermissionEngine
  fileAccessLimit?: BuddySettings['limits']['fileAccess']
  getToolScopeDenial?: (toolName: string) => string | null
}

export interface ToolAuthorizationCall {
  input: unknown
  toolCallId: string
  toolName: string
}

export interface ToolExecutionPermit {
  readonly call: ToolAuthorizationCall
  readonly classification: BuddyToolClassification
  readonly executionProfile: BuddyExecutionProfile
  readonly grants: readonly DirectoryGrant[]
  readonly lifetime: AbortSignal
}

export class ToolAuthorizationService {
  readonly #options: ToolAuthorizationOptions
  readonly #engine: PermissionEngine
  #settings: BuddyPermissionSettings
  #settingsLifetime = new AbortController()
  readonly #permits = new WeakMap<BuddyExtensionRunContext, Map<string, ToolExecutionPermit>>()

  constructor(options: ToolAuthorizationOptions) {
    this.#options = options
    this.#engine = options.engine ?? new PermissionEngine()
    this.#settings = { approvalPolicy: options.approvalPolicy, executionProfile: options.executionProfile }
  }

  updatePermissionSettings(settings: BuddyPermissionSettings): void {
    if (settings.approvalPolicy === this.#settings.approvalPolicy && settings.executionProfile === this.#settings.executionProfile)
      return
    const previous = this.#settingsLifetime
    this.#settings = { ...settings }
    this.#settingsLifetime = new AbortController()
    previous.abort()
  }

  getToolScopeDenial(toolName: string): string | null {
    return this.#options.getToolScopeDenial?.(toolName) ?? null
  }

  getExecutionPermit(event: ToolAuthorizationCall, run: BuddyExtensionRunContext): ToolExecutionPermit | null {
    const permit = this.#permits.get(run)?.get(event.toolCallId)
    return permit && permit.call.toolName === event.toolName && JSON.stringify(permit.call.input) === JSON.stringify(event.input) ? permit : null
  }

  isPermitCurrent(permit: ToolExecutionPermit, run: BuddyExtensionRunContext): boolean {
    return !run.signal.aborted && !permit.lifetime.aborted
      && this.#permits.get(run)?.get(permit.call.toolCallId) === permit
      && JSON.stringify(permit.grants) === JSON.stringify(this.#options.getGrants())
      && this.getToolScopeDenial(permit.call.toolName) === null
  }

  releaseExecutionPermit(event: ToolAuthorizationCall, run: BuddyExtensionRunContext): void {
    this.#permits.get(run)?.delete(event.toolCallId)
    this.#options.executionPermissions?.release(run, event.toolCallId)
  }

  async authorize(
    event: ToolAuthorizationCall,
    run: BuddyExtensionRunContext,
    declared: BuddyToolClassification = {},
    resource: { network?: SandboxNetworkTarget, signal?: AbortSignal } = {},
  ): Promise<string | null> {
    while (true) {
      const lifetime = this.#settingsLifetime.signal
      try {
        return await this.#authorize(event, run, declared, resource, this.#settings, lifetime)
      }
      catch (error) {
        if (!lifetime.aborted || run.signal.aborted || resource.signal?.aborted)
          throw error
      }
    }
  }

  async #authorize(
    event: ToolAuthorizationCall,
    run: BuddyExtensionRunContext,
    declared: BuddyToolClassification,
    resource: { network?: SandboxNetworkTarget, signal?: AbortSignal },
    settings: BuddyPermissionSettings,
    lifetime: AbortSignal,
  ): Promise<string | null> {
    const options = this.#options
    let authorized = false
    if (!resource.network)
      this.releaseExecutionPermit(event, run)
    try {
      const signal = AbortSignal.any([lifetime, run.signal, ...resource.signal ? [resource.signal] : []])
      signal.throwIfAborted()
      const scopeDenial = this.getToolScopeDenial(event.toolName)
      if (scopeDenial)
        return scopeDenial
      if (options.fileAccessLimit === 'read_only' && ((declared.access === 'execute' && declared.shellBoundary !== 'sandbox')
        || (!declared.access && !['read', 'find', 'grep', 'ls', 'write', 'edit'].includes(event.toolName)))) {
        return 'ROLE_FILE_ACCESS_READ_ONLY'
      }
      await run.flushProjectedEvents()
      const decision = await this.#engine.decide({
        access: declared.access,
        approvalAvailable: options.approvalAvailable,
        approvalPolicy: settings.approvalPolicy,
        approval: declared.approval,
        arguments: event.input,
        cwd: options.cwd,
        forceAsk: declared.forceAsk,
        requireApproval: declared.requireApproval,
        shellBoundary: declared.shellBoundary,
        grants: options.getGrants(),
        sandboxDirectories: options.getSandboxDirectories?.(run),
        owner: options.owner,
        paths: declared.paths,
        profile: options.fileAccessLimit === 'read_only' ? 'read_only' : settings.executionProfile,
        toolName: event.toolName,
      })
      signal.throwIfAborted()
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
          runSignal: AbortSignal.any([run.signal, lifetime]),
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
        signal.throwIfAborted()
        if (approval.decision === 'denied')
          return 'APPROVAL_DENIED'
        approvedOnce = approval.decision === 'approved_once'
      }
      signal.throwIfAborted()
      const validation = await declared.validateBeforeExecution?.()
      signal.throwIfAborted()
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
      if (decision.sandboxDirectory) {
        if (!options.applySandboxDirectory)
          return 'DIRECTORY_GRANT_FAILED'
        try {
          await options.applySandboxDirectory(run, decision.sandboxDirectory)
        }
        catch {
          signal.throwIfAborted()
          return 'SANDBOX_DIRECTORY_CHANGED'
        }
      }
      if (decision.type === 'ask') {
        signal.throwIfAborted()
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
      if (!resource.network) {
        const permits = this.#permits.get(run) ?? new Map<string, ToolExecutionPermit>()
        permits.set(event.toolCallId, {
          call: copyEventSnapshot({ input: event.input, toolCallId: event.toolCallId, toolName: event.toolName }),
          classification: { ...declared, paths: declared.paths ? copyEventSnapshot(declared.paths) : undefined },
          executionProfile: options.fileAccessLimit === 'read_only' ? 'read_only' : settings.executionProfile,
          grants: copyEventSnapshot(options.getGrants()),
          lifetime,
        })
        this.#permits.set(run, permits)
      }
      return null
    }
    finally {
      if (!authorized && !resource.network)
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
