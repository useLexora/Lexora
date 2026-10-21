import type { BuddySettings } from '../../../shared/buddies/buddySettings'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { PathApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { NetworkOperation } from '../../../shared/permissions/networkPermissions'
import type { BuddyPermissionSettings } from '../../../shared/permissions/permissionMode'
import type { SandboxDirectoryGrant, SandboxNetworkTarget } from '../../../shared/permissions/shellSandbox'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { ApprovalService } from '../approvals/ApprovalService'
import type { BuddyToolClassification } from '../approvals/toolClassification'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { NetworkPermissionsStore } from './NetworkPermissionsClient'
import type { GrantOwner, GrantProposal, PermissionDecision } from './permissionContract'
import type { ToolExecutionPermissions } from './ToolExecutionPermissions'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { normalizeNetworkHost, resolveNetworkPermission } from '../../../shared/permissions/networkPermissions'
import { validateSandboxDirectory } from '../sandbox/SandboxDirectoryPermissions'
import { PathClassificationError } from './classifyPath'
import { PermissionEngine } from './PermissionEngine'

export interface ToolAuthorizationOptions {
  networkPermissions?: NetworkPermissionsStore
  approvalService: Pick<ApprovalService, 'request'> & Partial<Pick<ApprovalService, 'clearRunAuthorizations'>>
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
  readonly #networkSettings = new WeakMap<BuddyExtensionRunContext, string>()
  readonly #networkPermits = new WeakMap<BuddyExtensionRunContext, Map<string, Map<string, { settings: string, lifetime: AbortSignal }>>>()

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
    this.#networkPermits.get(run)?.delete(event.toolCallId)
    this.#options.executionPermissions?.release(run, event.toolCallId)
  }

  async authorize(
    event: ToolAuthorizationCall,
    run: BuddyExtensionRunContext,
    declared: BuddyToolClassification = {},
    resource: { network?: SandboxNetworkTarget, networkOperation?: NetworkOperation, signal?: AbortSignal } = {},
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
    resource: { network?: SandboxNetworkTarget, networkOperation?: NetworkOperation, signal?: AbortSignal },
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
      const networkSettings = await options.networkPermissions?.get(signal)
      const networkOperation = resource.networkOperation ?? 'access'
      const networkHost = resource.network && normalizeNetworkHost(resource.network.host)
      if (resource.network && !networkHost)
        return 'VALIDATION_FAILED'
      const networkPermission = networkSettings && networkHost
        ? resolveNetworkPermission(networkSettings, networkHost, networkOperation)
        : declared.networkManaged && declared.access === 'network' ? 'allow' : undefined
      const networkKey = resource.network ? JSON.stringify([networkHost, resource.network.port, networkOperation]) : ''
      const networkRevision = JSON.stringify(networkSettings ?? null)
      if (networkSettings) {
        const previousSettings = this.#networkSettings.get(run)
        if (previousSettings !== undefined && previousSettings !== networkRevision) {
          this.#networkPermits.delete(run)
          options.approvalService.clearRunAuthorizations?.(run.runId, 'permissions_changed')
        }
        this.#networkSettings.set(run, networkRevision)
      }
      if (networkPermission === 'deny')
        return 'NETWORK_PERMISSION_DENIED'
      const networkPermit = this.#networkPermits.get(run)?.get(event.toolCallId)?.get(networkKey)
      if (resource.network && networkPermit?.settings === networkRevision && !networkPermit.lifetime.aborted)
        return null
      await run.flushProjectedEvents()
      const decision = await this.#engine.decide({
        access: declared.access,
        networkPermission,
        approvalAvailable: options.approvalAvailable,
        approvalPolicy: declared.networkManaged && declared.access === 'network' ? 'policy' : settings.approvalPolicy,
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

      if (decision.type === 'ask') {
        const persistentDirectory = decision.grant ?? (decision.sandboxDirectory?.access === 'write'
          ? { owner: options.owner, root: decision.sandboxDirectory.path }
          : undefined)
        const persist = persistentDirectory && options.applyGrant
          ? async () => {
            signal.throwIfAborted()
            if (decision.sandboxDirectory)
              await validateSandboxDirectory(decision.sandboxDirectory)
            signal.throwIfAborted()
            await options.applyGrant!(persistentDirectory)
          }
          : networkHost && options.networkPermissions
            ? () => {
                signal.throwIfAborted()
                return options.networkPermissions!.allow(networkHost, networkOperation)
              }
            : undefined
        const approval = await options.approvalService.request({
          arguments: event.input,
          automation: declared.approval?.automation,
          browser: declared.approval?.browser,
          cwd: options.cwd,
          kind: decision.kind,
          network: resource.network,
          networkPermission: networkHost && resource.network
            ? { host: networkHost, port: resource.network.port, operation: networkOperation }
            : undefined,
          persist,
          persistentDirectory: persistentDirectory ? { owner: persistentDirectory.owner.kind, root: persistentDirectory.root } : undefined,
          paths: declared.approval?.paths ?? toPathReview(decision),
          reuse: networkHost && resource.network
            ? {
                operation: ['network', networkHost, resource.network.port, networkOperation, networkRevision, event.input],
                source: ['network', networkHost, resource.network.port, networkOperation, networkRevision],
              }
            : declared.approval?.reuse,
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
      }
      signal.throwIfAborted()
      const validation = await declared.validateBeforeExecution?.()
      signal.throwIfAborted()
      if (validation)
        return validation.reason
      const executionPaths = declared.paths ?? (['write', 'edit', 'read'].includes(event.toolName)
        && event.input && typeof event.input === 'object' && 'path' in event.input && typeof event.input.path === 'string'
        ? [{ path: event.input.path, mode: event.toolName === 'write' ? 'create' as const : 'existing' as const }]
        : undefined)
      if (!resource.network && executionPaths?.length) {
        try {
          await options.executionPermissions?.authorize(run, event.toolCallId, {
            cwd: options.cwd,
            grants: options.getGrants(),
            paths: executionPaths,
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
      if (networkHost && resource.network) {
        const current = await options.networkPermissions?.get(signal)
        const currentPermission = current && resolveNetworkPermission(current, networkHost, networkOperation)
        if (currentPermission === 'deny')
          return 'NETWORK_PERMISSION_DENIED'
        if (currentPermission === 'ask' && JSON.stringify(current) !== networkRevision)
          return this.#authorize(event, run, declared, resource, settings, lifetime)
        const calls = this.#networkPermits.get(run) ?? new Map()
        const targets = calls.get(event.toolCallId) ?? new Map()
        targets.set(networkKey, { settings: JSON.stringify(current ?? null), lifetime })
        calls.set(event.toolCallId, targets)
        this.#networkPermits.set(run, calls)
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
