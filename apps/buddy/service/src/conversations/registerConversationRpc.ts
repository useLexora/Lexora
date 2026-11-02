import type { AttachmentService } from '../attachments/AttachmentService'
import type { ChangeCaptureService } from '../changes/ChangeCaptureService'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'
import type { RunEventAvailability, RunEventReader } from '../events/RunEventPorts'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type {
  ArtifactRepository,
} from '../storage/artifactRepository'
import type { ConversationHistoryRepository } from '../storage/conversationHistoryRepository'
import type { ConversationIndexRepository } from '../storage/conversationIndexRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ConversationTimelineRepository } from '../storage/conversationTimelineRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRepository } from '../storage/runRepository'
import type { ConversationMetadataService } from './ConversationMetadataService'
import { conversationsRpc } from '../../../shared/conversation/conversationApi'

import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import {
  withMessageAttachments,
} from '../attachments/publicAttachment'
import { RunEventCorruptionError } from '../events/RunEventFailure'
import { BuddyServiceError, registerRuntimeRequest } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'
import {
  createConversationTimelineCursor,
  parseConversationTimelineCursor,
} from './conversationTimelineCursor'
import {
  createMessagePageCursor,
  parseMessagePageCursor,
} from './messagePageCursor'
import { projectRunOutputs } from './projectRunOutputs'

type ConversationRpcRepository = Pick<
  ConversationRepository,
  | 'findById'
> & Pick<
  ConversationHistoryRepository,
  'listBranches' | 'listMessagePage'
> & ConversationIndexRepository & ConversationTimelineRepository

export interface RegisterConversationRpcOptions {
  artifacts: Pick<ArtifactRepository, 'listForConversation'>
  attachments: Pick<AttachmentService, 'listForConversation'>
  changes: Pick<ChangeCaptureService, 'listSummariesForRuns'>
  conversations: ConversationRpcRepository
  metadata: Pick<ConversationMetadataService, 'rename' | 'setPermissionSettings' | 'setModelSelection' | 'getModelControls' | 'listMembers' | 'addMember' | 'removeMember' | 'setBuddy' | 'moveToSpace' | 'activateBranch'>
  deleteConversation: (conversationId: string) => Promise<boolean>
  eventLog: { listForRuns: (runIds: readonly string[]) => BuddyRunEvent[] } & Pick<RunEventReader, 'verifyRun'> & Partial<Pick<RunEventAvailability, 'getRecoveryFailures'>>
  isDeleting: (conversationId: string) => boolean
  rpc: RuntimeRequestRegistrar
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runs: Pick<RunRepository, 'listForTimeline'>
}

export function registerConversationRpc(options: RegisterConversationRpcOptions): () => void {
  const disposers: Array<() => void> = []
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.listMembers, input => options.metadata.listMembers(input.conversationId)))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.addMember, input => options.metadata.addMember({ id: input.conversationId, buddyId: input.buddyId })))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.removeMember, input => options.metadata.removeMember({ id: input.conversationId, buddyId: input.buddyId })))

  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.list, (input) => {
    return input.filter
      ? options.conversations.listRecent(input.limit ?? 100, input.filter)
      : options.conversations.listRecent(input.limit ?? 100)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.get, (input) => {
    return requireActiveConversation(options, input.conversationId)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.getModelControls, input => options.metadata.getModelControls(input.conversationId, input.actorId)))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.rename, (input) => {
    return options.metadata.rename({
      id: input.conversationId,
      title: input.title,
    })
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.setPermissionSettings, async (input) => {
    return options.metadata.setPermissionSettings({
      approvalPolicy: input.approvalPolicy,
      executionProfile: input.executionProfile,
      id: input.conversationId,
    })
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.setBuddy, input => options.metadata.setBuddy({ id: input.conversationId, buddyId: input.buddyId })))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.moveToSpace, input => options.metadata.moveToSpace({ id: input.conversationId, spaceId: input.spaceId })))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.setModelSelection, async (input) => {
    return options.metadata.setModelSelection({
      id: input.conversationId,
      modelSelection: input.modelSelection,
      actorId: input.actorId,
      runId: input.targetRunId,
    })
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.delete, async (input) => {
    return options.deleteConversation(input.conversationId)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.activateBranch, (input) => {
    return options.metadata.activateBranch(input)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.listBranches, (input) => {
    requireValue(options.conversations.findById(input.conversationId))
    if (options.isDeleting(input.conversationId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    return options.conversations.listBranches(input.conversationId)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.listMessages, async (input) => {
    const conversation = requireActiveConversation(options, input.conversationId)
    const branchId = input.branchId ?? requireValue(conversation.activeBranchId)
    const readPage = () => options.conversations.listMessagePage(
      input.conversationId,
      branchId,
      {
        beforeMessageId: input.cursor
          ? parseMessagePageCursor(input.cursor, {
              branchId,
              conversationId: input.conversationId,
            })
          : null,
        limit: input.limit ?? 100,
      },
    )
    const page = await readVerifiedHistoryPage(options, readPage, page => page.items.flatMap(item => item.runId ? [item.runId] : []))
    requireActiveConversation(options, input.conversationId)
    return {
      items: withMessageAttachments(
        page.items,
        options.attachments.listForConversation(input.conversationId),
      ),
      nextCursor: page.nextBeforeMessageId
        ? createMessagePageCursor({
            beforeMessageId: page.nextBeforeMessageId,
            branchId,
            conversationId: input.conversationId,
          })
        : null,
    }
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.listTimeline, async (input) => {
    const conversation = requireActiveConversation(options, input.conversationId)
    const branchId = input.branchId ?? requireValue(conversation.activeBranchId)
    const readPage = () => options.conversations.listTimelinePage(
      input.conversationId,
      branchId,
      {
        before: input.cursor
          ? parseConversationTimelineCursor(input.cursor, {
              branchId,
              conversationId: input.conversationId,
            })
          : null,
        limit: input.limit ?? 100,
      },
    )
    const readTimeline = () => {
      const page = readPage()
      const messages = page.items.filter(item => item.kind === 'message')
      const runs = options.runs.listForTimeline(input.conversationId, branchId, messages.filter(item => item.role === 'user').map(item => item.id), messages.flatMap(item => item.runId ? [item.runId] : []))
      return { page, runs }
    }
    const { page, runs } = await readVerifiedHistoryPage(options, readTimeline, ({ page, runs }) => [
      ...runs.map(run => run.id),
      ...page.items.flatMap(item => item.kind === 'message' && item.runId ? [item.runId] : []),
    ], true)
    requireActiveConversation(options, input.conversationId)
    const items = withMessageAttachments(
      page.items,
      options.attachments.listForConversation(input.conversationId),
    )
    const runEvents = options.eventLog.listForRuns(runs.map(run => run.id))
    const runIds = runs.map(run => run.id)
    const quarantined = new Set(options.eventLog.getRecoveryFailures?.().map(failure => failure.runId))
    return {
      changeSets: options.changes.listSummariesForRuns(runIds),
      items,
      nextCursor: page.nextBefore
        ? createConversationTimelineCursor({
            before: page.nextBefore,
            branchId,
            conversationId: input.conversationId,
          })
        : null,
      outputs: projectRunOutputs(
        runEvents,
        options.artifacts.listForConversation(input.conversationId),
      ),
      runEvents: runEvents.map(toPublicRunEvent),
      runs: runs.map(run => toPublicRun(
        quarantined.has(run.id) ? { ...run, errorCode: 'EVENT_LOG_CORRUPTED' } : run,
        options.runInputs.findByRunId(run.id)?.reasoning ?? null,
      )),
    }
  }))

  return () => disposers.splice(0).forEach(dispose => dispose())
}

async function readVerifiedHistoryPage<T>(
  options: Pick<RegisterConversationRpcOptions, 'eventLog'>,
  read: () => T,
  runIds: (page: T) => readonly string[],
  tolerateCorruption = false,
): Promise<T> {
  const verified = new Set<string>()
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const runId of new Set(runIds(read()))) {
      if (verified.has(runId))
        continue
      try {
        await options.eventLog.verifyRun(runId)
      }
      catch (error) {
        if (!tolerateCorruption || !(error instanceof RunEventCorruptionError))
          throw error
      }
      verified.add(runId)
    }
    const page = read()
    if (runIds(page).every(runId => verified.has(runId)))
      return page
  }
  throw new BuddyServiceError('VALIDATION_FAILED')
}

function requireActiveConversation(
  options: Pick<RegisterConversationRpcOptions, 'conversations'>,
  conversationId: string,
) {
  const conversation = requireValue(options.conversations.findById(conversationId))
  if (conversation.deletedAt !== null)
    throw new BuddyServiceError('VALIDATION_FAILED')
  return conversation
}

function requireValue<T>(value: T | null): T {
  if (value === null)
    throw new BuddyServiceError('VALIDATION_FAILED')
  return value
}
