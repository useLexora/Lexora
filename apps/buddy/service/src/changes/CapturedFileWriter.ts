import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { FilePublication, FileResourceCoordinator } from '../files/FileResourceCoordinator'
import type { ToolAuthorizationService } from '../permissions/ToolAuthorizationService'
import type { ChangeCaptureService, ChangeInvocationHandle } from './ChangeCaptureService'
import type { MutationCoordinator } from './MutationCoordinator'
import { randomUUID } from 'node:crypto'
import { resolveFilePath } from '../../../platform/filesystem/resolveFilePath'

export type CapturedFileWriter = (paths: readonly string[], write: (publish: (input: FilePublication) => Promise<void>) => Promise<void>) => Promise<void>
export type CapturedFileWriterFactory = (event: ToolCallEvent) => CapturedFileWriter

export function createCapturedFileWriter(options: {
  conversationId: string
  cwd: string
  run: BuddyExtensionRunContext
  event: ToolCallEvent
  authorization: ToolAuthorizationService
  mutations: MutationCoordinator
  files: Pick<FileResourceCoordinator, 'withStagingDirectory' | 'fileWriteClaims' | 'writeFile'>
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
  return async (paths, write) => options.files.withStagingDirectory(async (stagingDirectory) => {
    await validate()
    const targets = await Promise.all(paths.map(path => resolveFilePath(path, 'create', options.cwd)))
    if (targets.some(path => path.isDirectory))
      throw new Error('VALIDATION_FAILED')
    run.onToolExecutionPhase?.({ toolCallId: event.toolCallId, toolName: event.toolName, phase: 'resource' })
    const claims = await options.files.fileWriteClaims(targets.map(path => path.canonicalPath))
    const lease = await mutations.acquire({ runId: run.runId, invocationId: randomUUID(), lifetime: 'runtime', claims: [...claims, { kind: 'tree', canonicalPath: stagingDirectory }], signal })
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
      await mutations.withInvocation(lease, () => write(async (input) => {
        await validate()
        await options.files.writeFile(lease.invocationId, stagingDirectory, { ...input, assertCurrent: async () => {
          await validate()
          await input.assertCurrent?.()
          await validate()
        } }, signal)
      }))
      isError = false
    }
    finally {
      run.onToolExecutionPhase?.({ toolCallId: event.toolCallId, toolName: event.toolName, phase: 'capturing' })
      try {
        if (handle)
          await changes.finishInvocation(handle, { isError, hasConcurrentChanges: lease.hasConcurrentChanges }).catch(partial)
      }
      finally { await lease.release() }
    }
  })
}
