import type { AttachmentService } from '../attachments/AttachmentService'
import type { ChangeCaptureService } from '../changes/ChangeCaptureService'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'
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
  metadata: Pick<ConversationMetadataService, 'rename' | 'setPermissionSettings' | 'setModelSelection' | 'activateBranch'>
  deleteConversation: (conversationId: string) => Promise<boolean>
  eventLog: { listForRuns: (runIds: readonly string[]) => BuddyRunEvent[] }
  isDeleting: (conversationId: string) => boolean
  rpc: RuntimeRequestRegistrar
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runs: Pick<RunRepository, 'listForTimeline'>
}

export function registerConversationRpc(options: RegisterConversationRpcOptions): () => void {
  const disposers: Array<() => void> = []

  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.list, (input) => {
    return options.conversations.listRecent(input.limit ?? 100)
  }))
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.get, (input) => {
    return requireActiveConversation(options, input.conversationId)
  }))
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
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.setModelSelection, async (input) => {
    return options.metadata.setModelSelection({
      id: input.conversationId,
      modelSelection: input.modelSelection,
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
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.listMessages, (input) => {
    const conversation = requireActiveConversation(options, input.conversationId)
    const branchId = input.branchId ?? requireValue(conversation.activeBranchId)
    const page = options.conversations.listMessagePage(
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
  disposers.push(registerRuntimeRequest(options.rpc, conversationsRpc.listTimeline, (input) => {
    const conversation = requireActiveConversation(options, input.conversationId)
    const branchId = input.branchId ?? requireValue(conversation.activeBranchId)
    const page = options.conversations.listTimelinePage(
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
    const items = withMessageAttachments(
      page.items,
      options.attachments.listForConversation(input.conversationId),
    )
    const messageItems = items.filter(item => item.kind === 'message')
    const runs = options.runs.listForTimeline(
      input.conversationId,
      branchId,
      messageItems.filter(item => item.role === 'user').map(item => item.id),
      messageItems.flatMap(item => item.runId ? [item.runId] : []),
    )
    const runEvents = options.eventLog.listForRuns(runs.map(run => run.id))
    const runIds = runs.map(run => run.id)
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
        run,
        options.runInputs.findByRunId(run.id)?.reasoning ?? null,
      )),
    }
  }))

  return () => disposers.splice(0).forEach(dispose => dispose())
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
