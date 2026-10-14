import type { ShellApprovalReason } from '../../../shared/permissions/approvalReviewPayload'
import type { ShellCommandPolicy, ToolDecision } from '../approvals/toolPolicyContract'
import type { PathClassification } from './classifyPath'
import type { PermissionOutcome } from './decisionTable'
import type {
  AccessKind,
  GrantProposal,
  PermissionDecision,
  PermissionPath,
  PermissionRequest,
} from './permissionContract'
import type { SensitivePathMatcher } from './sensitivePaths'
import { stat } from 'node:fs/promises'
import process from 'node:process'
import { sandboxDirectoryRequestSchema } from '../../../shared/permissions/shellSandbox'
import { ShellPolicy } from '../approvals/ShellPolicy'
import { classifyPath, PathClassificationError, toGrantRoot } from './classifyPath'
import { lookupPermissionOutcome } from './decisionTable'
import { allow, ask, deny } from './permissionContract'
import { createSensitivePathMatcher } from './sensitivePaths'

type ShellToolName = 'bash' | 'powershell'

const OUTCOME_SEVERITY: Record<PermissionOutcome, number> = {
  allow: 0,
  delegate: 1,
  delegate_allowlist: 2,
  ask: 3,
  ask_grant: 4,
  deny_profile: 5,
  deny_sensitive: 6,
}

const BUILTIN_TOOL_ACCESS: Record<string, AccessKind> = {
  bash: 'execute',
  edit: 'write',
  find: 'read',
  grep: 'read',
  lexora_host_shell: 'execute',
  ls: 'read',
  powershell: 'execute',
  read: 'read',
  write: 'write',
}

export interface PermissionEngineOptions {
  platform?: NodeJS.Platform
  sensitive?: SensitivePathMatcher
  shellPolicies?: Partial<Record<ShellToolName, ShellCommandPolicy>>
}

export class PermissionEngine {
  readonly #sensitive: SensitivePathMatcher
  readonly #hostShellToolName: ShellToolName
  readonly #shellPolicies: Readonly<Record<ShellToolName, ShellCommandPolicy>>

  constructor(options: PermissionEngineOptions = {}) {
    const platform = options.platform ?? process.platform
    this.#sensitive = options.sensitive ?? createSensitivePathMatcher()
    this.#hostShellToolName = platform === 'win32' ? 'powershell' : 'bash'
    this.#shellPolicies = {
      bash: options.shellPolicies?.bash ?? new ShellPolicy({ dialect: 'bash', platform }),
      powershell: options.shellPolicies?.powershell
        ?? new ShellPolicy({ dialect: 'powershell', platform }),
    }
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    try {
      return await this.#decide(request)
    }
    catch (error) {
      if (error instanceof PathClassificationError)
        return deny(error.code, 'invalid')
      if (error instanceof PermissionValidationError)
        return deny('VALIDATION_FAILED', 'invalid')
      throw error
    }
  }

  async #decide(request: PermissionRequest): Promise<PermissionDecision> {
    const access = request.access ?? BUILTIN_TOOL_ACCESS[request.toolName] ?? null
    if (request.shellBoundary === 'sandbox' && request.toolName === 'lexora_authorize_directory')
      return this.#decideSandboxDirectory(request)
    if (request.toolName === 'lexora_host_shell') {
      if (request.profile === 'read_only')
        return deny('READ_ONLY_PROFILE', 'profile')
      if (request.profile !== 'full_access')
        return finalizeDecision(request, this.#forcedShellAsk(request, 'sandbox-bypass'))
    }
    if (request.shellBoundary === 'sandbox' && access === 'execute') {
      readStringProperty(request.arguments, 'command')
      if (request.forceAsk)
        return finalizeDecision(request, this.#forcedShellAsk(request, 'forced-confirmation'))
      return finalizeDecision(request, applyApprovalPolicy(request, access, [], allow()))
    }
    const shell = access === 'execute' ? await this.#classifyShell(request) : undefined
    if (shell?.type === 'file-operation') {
      return this.#decide({
        ...request,
        access: shell.access,
        paths: [
          ...request.paths ?? [],
          ...shell.paths.map(path => ({ mode: 'existing' as const, path })),
        ],
      })
    }
    const paths = resolveRequestPaths(request, access)
    const classifications: PathClassification[] = []
    for (const path of paths) {
      classifications.push(await classifyPath({
        cwd: request.cwd,
        grants: request.grants,
        mode: path.mode,
        path: path.path,
        sensitive: this.#sensitive,
      }))
    }

    if (!access)
      return finalizeDecision(request, this.#unknownAccess(request, classifications))

    const worst = this.#worstOutcome(request, access, classifications)
    const decision = this.#toDecision(
      request,
      access,
      worst.outcome,
      worst.classification,
      classifications,
      shell,
    )
    return finalizeDecision(
      request,
      applyApprovalPolicy(request, access, classifications, decision),
    )
  }

  async #decideSandboxDirectory(request: PermissionRequest): Promise<PermissionDecision> {
    const parsed = sandboxDirectoryRequestSchema.safeParse(request.arguments)
    if (!parsed.success)
      return deny('VALIDATION_FAILED', 'invalid')
    const input = parsed.data
    if (input.access === 'write' && request.profile === 'read_only')
      return deny('READ_ONLY_PROFILE', 'profile')
    const path = await classifyPath({ cwd: request.cwd, grants: request.grants, mode: 'existing', path: input.path, sensitive: this.#sensitive })
    if (path.zone === 'sensitive')
      return deny('SENSITIVE_PATH', 'sensitive')
    if (!path.isDirectory)
      return deny('INVALID_PATH', 'invalid')
    const metadata = await stat(path.canonicalPath, { bigint: true })
    return finalizeDecision(request, ask({
      kind: input.access,
      sandboxDirectory: { access: input.access, path: path.canonicalPath, reason: input.reason, device: String(metadata.dev), inode: String(metadata.ino) },
      summary: 'Expand isolated shell directory access for this run only',
    }))
  }

  async #classifyShell(request: PermissionRequest): Promise<ToolDecision | undefined> {
    const toolName = request.toolName === 'lexora_host_shell' ? this.#hostShellToolName : request.toolName as ShellToolName
    const policy = this.#shellPolicies[toolName]
    if (!policy)
      return undefined
    const decision = await policy.decide(readStringProperty(request.arguments, 'command'), request.cwd)
    if (decision.type === 'deny' || decision.type === 'file-operation')
      return decision
    let needsFileReview = false
    for (const path of new Set([...decision.readPaths ?? [], ...decision.readFiles ?? []])) {
      const fileOnly = decision.readFiles?.includes(path) ?? false
      let classification: PathClassification
      try {
        classification = await classifyPath({
          cwd: request.cwd,
          grants: request.grants,
          mode: 'create',
          path,
          sensitive: this.#sensitive,
        })
      }
      catch (error) {
        if (!(error instanceof PathClassificationError) || error.code !== 'PATH_NOT_FOUND')
          throw error
        needsFileReview = true
        continue
      }
      if (classification.zone === 'sensitive') {
        return {
          forceAsk: true,
          kind: 'shell',
          reason: 'sensitive-path',
          summary: 'Read a sensitive location from the shell',
          type: 'ask',
        }
      }
      needsFileReview ||= fileOnly && classification.isDirectory
    }
    return needsFileReview && decision.type === 'allow'
      ? { kind: 'shell', reason: 'unsafe-arguments', summary: 'Review shell file targets', type: 'ask' }
      : decision
  }

  #unknownAccess(
    request: PermissionRequest,
    classifications: readonly PathClassification[],
  ): PermissionDecision {
    if (classifications.some(entry => entry.zone === 'sensitive'))
      return deny('SENSITIVE_PATH', 'sensitive')
    return ask({
      kind: request.approval?.kind ?? 'system',
      summary: request.approval?.summary ?? 'Use a tool with unknown local side effects',
    })
  }

  #worstOutcome(
    request: PermissionRequest,
    access: AccessKind,
    classifications: readonly PathClassification[],
  ): { classification: PathClassification | null, outcome: PermissionOutcome } {
    let worst: { classification: PathClassification | null, outcome: PermissionOutcome } = {
      classification: null,
      outcome: lookupPermissionOutcome({ access, profile: request.profile, zone: 'workspace' }),
    }
    for (const classification of classifications) {
      let outcome = lookupPermissionOutcome({
        access,
        profile: request.profile,
        zone: classification.zone,
      })
      if (
        access === 'delete'
        && request.profile === 'workspace_write'
        && outcome === 'allow'
        && (!classification.isFile || isGitMetadata(classification))
      ) {
        outcome = 'ask'
      }
      if (OUTCOME_SEVERITY[outcome] >= OUTCOME_SEVERITY[worst.outcome])
        worst = { classification, outcome }
    }
    return worst
  }

  #toDecision(
    request: PermissionRequest,
    access: AccessKind,
    outcome: PermissionOutcome,
    classification: PathClassification | null,
    classifications: readonly PathClassification[],
    shell: ToolDecision | undefined,
  ): PermissionDecision {
    const forceAsk = Boolean(request.forceAsk)
      || (access === 'read' && classifications.some(entry => entry.zone === 'sensitive'))
      || (shell?.type === 'ask' && shell.forceAsk === true)
    switch (outcome) {
      case 'deny_sensitive':
        return deny('SENSITIVE_PATH', 'sensitive')
      case 'deny_profile':
        return deny('READ_ONLY_PROFILE', 'profile')
      case 'delegate':
      case 'delegate_allowlist':
        return this.#decideShell(request, outcome, shell)
      case 'allow':
        if (forceAsk && shell)
          return this.#forcedShellAsk(request, shell.type === 'ask' ? shell.reason : undefined)
        return forceAsk
          ? ask({
              kind: request.approval?.kind ?? approvalKindFor(access),
              paths: toDecisionPaths(classifications),
              summary: request.approval?.summary ?? summaryFor(access),
            })
          : allow()
      case 'ask':
        return ask({
          kind: request.approval?.kind ?? approvalKindFor(access),
          paths: toDecisionPaths(classifications),
          summary: request.approval?.summary ?? summaryFor(access),
        })
      case 'ask_grant': {
        const grants = classifications
          .filter(entry => lookupPermissionOutcome({
            access,
            profile: request.profile,
            zone: entry.zone,
          }) === 'ask_grant')
          .map(entry => toGrantProposal(request, entry))
          .filter((grant, index, all) => (
            all.findIndex(candidate => candidate.root === grant.root) === index
          ))
        if (grants.length > 1)
          return deny('MULTIPLE_DIRECTORY_GRANTS_REQUIRED', 'invalid')
        return ask({
          ...(grants[0]
            ? { grant: grants[0] }
            : classification
              ? { grant: toGrantProposal(request, classification) }
              : {}),
          kind: request.approval?.kind ?? approvalKindFor(access),
          paths: toDecisionPaths(classifications),
          summary: request.approval?.summary ?? summaryFor(access),
        })
      }
    }
  }

  #decideShell(
    request: PermissionRequest,
    outcome: 'delegate' | 'delegate_allowlist',
    decision: ToolDecision | undefined,
  ): PermissionDecision {
    if (!decision) {
      if (outcome === 'delegate_allowlist')
        return deny('READ_ONLY_PROFILE', 'profile')
      return request.profile === 'full_access' && !request.forceAsk
        ? allow()
        : ask({
            kind: request.approval?.kind ?? 'system',
            summary: request.approval?.summary ?? summaryFor('execute'),
          })
    }
    if (decision.type === 'allow')
      return request.forceAsk ? this.#forcedShellAsk(request) : allow()
    if (decision.type !== 'ask')
      return deny('VALIDATION_FAILED', 'invalid')
    if (decision.forceAsk)
      return this.#forcedShellAsk(request, decision.reason)
    if (outcome === 'delegate_allowlist')
      return deny('READ_ONLY_PROFILE', 'profile')
    if (request.profile === 'full_access' && !request.forceAsk)
      return allow()
    return ask({
      kind: 'shell',
      shell: { cwd: request.cwd, reason: request.forceAsk ? 'forced-confirmation' : decision.reason ?? 'unknown-command' },
      summary: request.approval?.summary ?? 'Run a host shell command',
    })
  }

  #forcedShellAsk(request: PermissionRequest, reason: ShellApprovalReason = 'forced-confirmation'): PermissionDecision {
    return ask({
      kind: 'shell',
      shell: { cwd: request.cwd, reason },
      summary: request.approval?.summary ?? 'Run a host shell command',
    })
  }
}

function applyApprovalPolicy(
  request: PermissionRequest,
  access: AccessKind,
  classifications: readonly PathClassification[],
  decision: PermissionDecision,
): PermissionDecision {
  if (
    request.approvalPolicy !== 'manual'
    || decision.type !== 'allow'
    || !requiresManualApproval(access)
  ) {
    return decision
  }
  return ask({
    kind: request.approval?.kind ?? approvalKindFor(access),
    paths: toDecisionPaths(classifications),
    ...(['bash', 'powershell', 'lexora_host_shell'].includes(request.toolName)
      && access === 'execute'
      ? { shell: { cwd: request.cwd, reason: 'manual-policy' as const, boundary: request.shellBoundary ?? 'host' as const } }
      : {}),
    summary: request.approval?.summary ?? manualApprovalSummaryFor(access),
  })
}

function requiresManualApproval(access: AccessKind): boolean {
  return access === 'delete'
    || access === 'execute'
    || access === 'interaction'
    || access === 'network'
    || access === 'write'
}

function manualApprovalSummaryFor(access: AccessKind): string {
  switch (access) {
    case 'delete':
      return 'Delete local content'
    case 'execute':
      return 'Run a host shell command'
    case 'interaction':
      return 'Interact with application content'
    case 'network':
      return 'Access an external network resource'
    case 'write':
      return 'Write local content'
    default:
      return 'Use a tool with local side effects'
  }
}

function toGrantProposal(
  request: PermissionRequest,
  classification: PathClassification,
): GrantProposal {
  return { owner: request.owner, root: toGrantRoot(classification) }
}

function resolveRequestPaths(
  request: PermissionRequest,
  access: AccessKind | null,
): readonly PermissionPath[] {
  if (request.paths?.length)
    return request.paths

  switch (request.toolName) {
    case 'read':
    case 'edit':
      return [{ mode: 'existing', path: readStringProperty(request.arguments, 'path') }]
    case 'write':
      return [{ mode: 'create', path: readStringProperty(request.arguments, 'path') }]
    case 'grep':
    case 'find':
    case 'ls':
      return [{
        mode: 'existing',
        path: readOptionalStringProperty(request.arguments, 'path') ?? request.cwd,
      }]
    default:
      break
  }

  if (request.paths)
    return request.paths
  if (access === 'delete' || access === 'write')
    throw new PermissionValidationError()
  return []
}

function approvalKindFor(access: AccessKind) {
  switch (access) {
    case 'delete':
      return 'delete' as const
    case 'execute':
      return 'shell' as const
    case 'network':
      return 'network' as const
    case 'read':
      return 'read' as const
    case 'render':
      return 'render' as const
    case 'write':
      return 'write' as const
    default:
      return 'system' as const
  }
}

function finalizeDecision(
  request: PermissionRequest,
  decision: PermissionDecision,
): PermissionDecision {
  const requiredDecision = request.requireApproval && decision.type === 'allow'
    ? ask({
        kind: request.approval?.kind ?? approvalKindFor(request.access ?? 'interaction'),
        summary: request.approval?.summary ?? summaryFor(request.access ?? 'interaction'),
      })
    : decision
  return requiredDecision.type === 'ask' && !request.approvalAvailable
    ? deny('APPROVAL_UNAVAILABLE_IN_BACKGROUND', 'profile')
    : requiredDecision
}

function toDecisionPaths(
  classifications: readonly PathClassification[],
): readonly { path: string, zone: PathClassification['zone'] }[] | undefined {
  const paths = classifications.map(classification => ({
    path: classification.canonicalPath,
    zone: classification.zone,
  }))
  return paths.length > 0 ? paths : undefined
}

function isGitMetadata(classification: PathClassification): boolean {
  return [classification.requestedPath, classification.canonicalPath]
    .some(path => path.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git'))
}

function summaryFor(access: AccessKind): string {
  switch (access) {
    case 'delete':
      return 'Delete local content'
    case 'execute':
      return 'Run a host shell command'
    case 'interaction':
      return 'Interact with application content'
    case 'network':
      return 'Access an external network resource'
    case 'read':
      return 'Read a sensitive location'
    case 'render':
      return 'Open local content in the browser'
    case 'write':
      return 'Write outside the workspace'
    default:
      return 'Use a tool with local side effects'
  }
}

class PermissionValidationError extends Error {
  constructor() {
    super('Lexora Buddy tool input is invalid')
    this.name = 'PermissionValidationError'
  }
}

function readStringProperty(value: unknown, key: string): string {
  const property = readOptionalStringProperty(value, key)
  if (property === undefined)
    throw new PermissionValidationError()
  return property
}

function readOptionalStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PermissionValidationError()
  const property = (value as Record<string, unknown>)[key]
  if (property === undefined)
    return undefined
  if (typeof property !== 'string' || !property.trim())
    throw new PermissionValidationError()
  return property
}
