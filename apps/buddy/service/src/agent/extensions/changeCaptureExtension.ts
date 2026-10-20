import type { ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import type { BuddyToolClassification, BuddyToolClassificationResult } from '../../approvals/toolClassification'
import type { ChangeCaptureService, ChangeInvocationHandle, ChangeInvocationInput } from '../../changes/ChangeCaptureService'
import type { MutationClaim, MutationCoordinator, MutationLease } from '../../changes/MutationCoordinator'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ToolAuthorizationService, ToolExecutionPermit } from '../../permissions/ToolAuthorizationService'
import type { BuddyExtensionRunContext } from './BuddyExtensionRunContext'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { containsCanonicalPath } from '../../../../platform/filesystem/filePaths'
import { resolveFilePath } from '../../../../platform/filesystem/resolveFilePath'
import { isToolClassificationFailure } from '../../approvals/toolClassification'
import { isPiShellToolName } from './piBuiltinTools'

export type BuddyToolWrapper = <Parameters extends TSchema, Details>(tool: ToolDefinition<Parameters, Details>) => ToolDefinition<Parameters, Details>

export type BuddyMutationEffect
  = { kind: 'none' }
    | { kind: 'paths', paths: readonly { path: string, mode: 'existing' | 'create' }[] }
    | { kind: 'workspace', ownedProcess?: boolean }
    | { kind: 'host', ownedProcess?: boolean }

interface MutationPlan {
  claims: readonly MutationClaim[]
  scope: ChangeInvocationInput['scope']
  grants: readonly DirectoryGrant[]
  coverage: 'complete' | 'partial'
  ownedProcess: boolean
}

export interface MutationToolOptions {
  conversationId: string
  cwd: string
  authorization: ToolAuthorizationService
  changes: Pick<ChangeCaptureService, 'beginInvocation' | 'finishInvocation' | 'markPartial'>
  mutations: MutationCoordinator
  getRunContext: () => BuddyExtensionRunContext | null
  getGrants: (run: BuddyExtensionRunContext, toolCallId: string) => readonly DirectoryGrant[]
  getWorkspaceGrants: (run: BuddyExtensionRunContext) => readonly DirectoryGrant[]
  classify: (event: ToolCallEvent, run: BuddyExtensionRunContext) => Promise<BuddyToolClassificationResult>
  mutationEffect?: (event: ToolCallEvent, classification: BuddyToolClassification) => BuddyMutationEffect | null
  workspaceMutationTools: readonly string[]
}

export function createMutationToolWrapper(options: MutationToolOptions): BuddyToolWrapper {
  return tool => ({
    ...tool,
    async execute(toolCallId, parameters, signal, onUpdate, context) {
      const run = options.getRunContext()
      if (!run)
        throw new Error('RUN_CONTEXT_UNAVAILABLE')
      const executionSignal = AbortSignal.any([run.signal, ...signal ? [signal] : []])
      const event: ToolCallEvent = { type: 'tool_call', toolCallId, toolName: tool.name, input: parameters as Record<string, unknown>, signal: executionSignal }
      let permit = options.authorization.getExecutionPermit(event, run)
      try {
        while (true) {
          executionSignal.throwIfAborted()
          if (!permit || !options.authorization.isPermitCurrent(permit, run))
            permit = await authorize(event, run, options)
          const plan = await resolveMutationPlan(event, run, permit, options)
          if (!plan) {
            if (!options.authorization.isPermitCurrent(permit, run))
              continue
            const validation = await permit.classification.validateBeforeExecution?.()
            if (validation)
              throw new Error(validation.reason)
            executionSignal.throwIfAborted()
            if (!options.authorization.isPermitCurrent(permit, run))
              continue
            return await tool.execute(toolCallId, parameters, executionSignal, onUpdate, context)
          }
          const lease = await options.mutations.acquire({ runId: run.runId, invocationId: randomUUID(), claims: plan.claims, lifetime: tool.name === 'write' || tool.name === 'edit' ? 'runtime' : 'external', signal: executionSignal })
          let handle: ChangeInvocationHandle | undefined
          let started = false
          let isError = true
          try {
            executionSignal.throwIfAborted()
            if (!await stillCurrent(plan, permit, event, run, options)) {
              permit = null
              continue
            }
            const validation = await permit.classification.validateBeforeExecution?.()
            if (validation)
              throw new Error(validation.reason)
            try {
              handle = await options.changes.beginInvocation({
                conversationId: options.conversationId,
                cwd: options.cwd,
                grants: plan.grants,
                invocationId: lease.invocationId,
                runId: run.runId,
                segmentId: lease.segmentId,
                toolCallId,
                toolName: tool.name,
                scope: plan.scope,
                coverage: plan.coverage,
              })
            }
            catch { await markPartial(options, run.runId) }
            executionSignal.throwIfAborted()
            const finalValidation = await permit.classification.validateBeforeExecution?.()
            if (finalValidation)
              throw new Error(finalValidation.reason)
            if (!await stillCurrent(plan, permit, event, run, options)) {
              permit = null
              continue
            }
            executionSignal.throwIfAborted()
            started = true
            const result = await options.mutations.withInvocation(lease, () => tool.execute(toolCallId, parameters, executionSignal, onUpdate, context))
            isError = 'isError' in result && result.isError === true
            return result
          }
          finally {
            const settlement = started && plan.ownedProcess && options.mutations.getInvocationSettlement(lease.invocationId) === 'unknown' ? 'unknown' : 'released'
            try {
              if (handle) {
                try {
                  await options.changes.finishInvocation(handle, { isError, settlement })
                }
                catch { await markPartial(options, run.runId) }
              }
            }
            finally {
              releaseMutation(lease, settlement)
            }
          }
        }
      }
      finally {
        options.authorization.releaseExecutionPermit(event, run)
      }
    },
  })
}

async function authorize(event: ToolCallEvent, run: BuddyExtensionRunContext, options: MutationToolOptions): Promise<ToolExecutionPermit> {
  const classification = await options.classify(event, run)
  if (isToolClassificationFailure(classification))
    throw new Error(classification.reason)
  const denial = await options.authorization.authorize(event, run, classification, { signal: event.signal })
  if (denial)
    throw new Error(denial)
  const permit = options.authorization.getExecutionPermit(event, run)
  if (!permit)
    throw new Error('TOOL_AUTHORIZATION_UNAVAILABLE')
  return permit
}

async function stillCurrent(plan: MutationPlan, permit: ToolExecutionPermit, event: ToolCallEvent, run: BuddyExtensionRunContext, options: MutationToolOptions): Promise<boolean> {
  if (!options.authorization.isPermitCurrent(permit, run))
    return false
  const current = await resolveMutationPlan(event, run, permit, options)
  return options.authorization.isPermitCurrent(permit, run) && JSON.stringify(current) === JSON.stringify(plan)
}

async function resolveMutationPlan(event: ToolCallEvent, run: BuddyExtensionRunContext, permit: ToolExecutionPermit, options: MutationToolOptions): Promise<MutationPlan | null> {
  const classification = permit.classification
  const effect = options.mutationEffect?.(event, classification) ?? defaultMutationEffect(event, classification, permit, options)
  if (effect.kind === 'none')
    return null
  const grants = options.getGrants(run, event.toolCallId)
  if (effect.kind === 'paths') {
    if (!effect.paths.length)
      return null
    const resolutions = await Promise.all(effect.paths.map(path => resolveFilePath(path.path, path.mode, options.cwd)))
    if (resolutions.every(path => !path.isDirectory)) {
      return {
        claims: resolutions.map(path => ({ kind: 'file', canonicalPath: path.canonicalPath })),
        scope: { kind: 'files', paths: resolutions.map(path => path.canonicalPath) },
        grants,
        coverage: 'complete',
        ownedProcess: false,
      }
    }
    const roots = resolutions.map(path => path.isDirectory ? path.canonicalPath : dirname(path.canonicalPath))
    return {
      claims: roots.map(canonicalPath => ({ kind: 'tree', canonicalPath })),
      scope: { kind: 'workspace' },
      grants: roots.flatMap((root) => {
        const grant = grants.find(grant => containsCanonicalPath(grant.canonicalRoot, root))
        return grant ? [{ ...grant, root, canonicalRoot: root }] : []
      }),
      coverage: roots.every(root => grants.some(grant => containsCanonicalPath(grant.canonicalRoot, root))) ? 'complete' : 'partial',
      ownedProcess: false,
    }
  }
  const workspace = effect.kind === 'workspace' && permit.executionProfile === 'read_only' ? [] : options.getWorkspaceGrants(run)
  for (const grant of workspace) {
    const current = await resolveFilePath(grant.canonicalRoot, 'existing')
    if (!current.isDirectory || current.canonicalPath !== grant.canonicalRoot)
      throw new Error('DIRECTORY_GRANT_CHANGED')
  }
  return {
    claims: effect.kind === 'host' ? [{ kind: 'host' }] : workspace.map(grant => ({ kind: 'tree', canonicalPath: grant.canonicalRoot })),
    scope: { kind: 'workspace' },
    grants: workspace,
    coverage: effect.kind === 'host' ? 'partial' : 'complete',
    ownedProcess: effect.ownedProcess === true,
  }
}

function defaultMutationEffect(event: ToolCallEvent, classification: BuddyToolClassification, permit: ToolExecutionPermit, options: MutationToolOptions): BuddyMutationEffect {
  if (event.toolName === 'lexora_authorize_directory')
    return { kind: 'none' }
  if (event.toolName === 'write' || event.toolName === 'edit') {
    const path = (event.input as { path?: unknown }).path
    if (typeof path !== 'string')
      throw new Error('VALIDATION_FAILED')
    return { kind: 'paths', paths: [{ path, mode: event.toolName === 'edit' ? 'existing' : 'create' }] }
  }
  if (event.toolName === 'lexora_host_shell' || (isPiShellToolName(event.toolName) && permit.executionProfile === 'full_access'))
    return { kind: 'host', ownedProcess: true }
  if (isPiShellToolName(event.toolName))
    return { kind: 'workspace', ownedProcess: true }
  if (event.toolName.startsWith('mcp__'))
    return { kind: 'host' }
  if ((classification.access === 'write' || classification.access === 'delete') && classification.paths?.length)
    return { kind: 'paths', paths: classification.paths }
  if (options.workspaceMutationTools.includes(event.toolName))
    return { kind: 'workspace' }
  if (classification.access === 'execute' || !classification.access)
    return { kind: 'host' }
  return { kind: 'none' }
}

async function markPartial(options: MutationToolOptions, runId: string): Promise<void> {
  try {
    await options.changes.markPartial({ conversationId: options.conversationId, runId })
  }
  catch {}
}

function releaseMutation(lease: MutationLease, settlement: 'released' | 'unknown'): void {
  if (settlement === 'unknown')
    lease.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
  else
    lease.release()
}
