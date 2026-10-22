import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ToolAuthorizationService } from '../permissions/ToolAuthorizationService'
import type { ChangeCaptureService, ChangeInvocationHandle } from './ChangeCaptureService'
import type { MutationCoordinator } from './MutationCoordinator'
import { randomUUID } from 'node:crypto'
import { resolveFilePath } from '../../../platform/filesystem/resolveFilePath'

export type CapturedFileWriter = (paths: readonly string[], write: () => Promise<void>) => Promise<void>
export type CapturedFileWriterFactory = (event: ToolCallEvent) => CapturedFileWriter

export function createCapturedFileWriter(options: {
  conversationId: string
  cwd: string
  run: BuddyExtensionRunContext
  event: ToolCallEvent
  authorization: ToolAuthorizationService
  mutations: MutationCoordinator
  changes: Pick<ChangeCaptureService, 'beginInvocation' | 'finishInvocation' | 'markPartial'>
  getGrants: () => readonly DirectoryGrant[]
}): CapturedFileWriter {
  const { run, event, authorization, mutations, changes } = options
  const permit = authorization.getExecutionPermit(event, run)
  const signal = AbortSignal.any([run.signal, ...event.signal ? [event.signal] : []])
  const validate = async () => {
    signal.throwIfAborted()
    if (!permit || !authorization.isPermitCurrent(permit, run))
      throw new Error('TOOL_AUTHORIZATION_UNAVAILABLE')
    const denial = await permit.classification.validateBeforeExecution?.()
    if (denial)
      throw new Error(denial.reason)
    signal.throwIfAborted()
    if (!authorization.isPermitCurrent(permit, run))
      throw new Error('TOOL_AUTHORIZATION_UNAVAILABLE')
  }
  const partial = () => changes.markPartial({ conversationId: options.conversationId, runId: run.runId }).catch(() => {})
  return async (paths, write) => {
    await validate()
    const targets = await Promise.all(paths.map(path => resolveFilePath(path, 'create', options.cwd)))
    if (targets.some(path => path.isDirectory))
      throw new Error('VALIDATION_FAILED')
    run.onToolExecutionPhase?.({ toolCallId: event.toolCallId, toolName: event.toolName, phase: 'resource' })
    const lease = await mutations.acquire({ runId: run.runId, invocationId: randomUUID(), lifetime: 'runtime', claims: targets.map(path => ({ kind: 'file', canonicalPath: path.canonicalPath })), signal })
    let handle: ChangeInvocationHandle | undefined
    let isError = true
    try {
      await validate()
      try {
        run.onToolExecutionPhase?.({ toolCallId: event.toolCallId, toolName: event.toolName, phase: 'capturing' })
        handle = await changes.beginInvocation({ conversationId: options.conversationId, cwd: options.cwd, grants: options.getGrants(), runId: run.runId, invocationId: lease.invocationId, segmentId: lease.segmentId, toolCallId: event.toolCallId, toolName: event.toolName, scope: { kind: 'files', paths: targets.map(path => path.canonicalPath) } })
      }
      catch { await partial() }
      await validate()
      for (const [index, path] of paths.entries()) {
        if ((await resolveFilePath(path, 'create', options.cwd)).canonicalPath !== targets[index]!.canonicalPath)
          throw new Error('DIRECTORY_GRANT_CHANGED')
      }
      await validate()
      run.onToolExecutionPhase?.({ toolCallId: event.toolCallId, toolName: event.toolName, phase: 'executing', executionBasis: 'tool' })
      await mutations.withInvocation(lease, write)
      isError = false
    }
    finally {
      run.onToolExecutionPhase?.({ toolCallId: event.toolCallId, toolName: event.toolName, phase: 'capturing' })
      try {
        if (handle)
          await changes.finishInvocation(handle, { isError }).catch(partial)
      }
      finally { lease.release() }
    }
  }
}
