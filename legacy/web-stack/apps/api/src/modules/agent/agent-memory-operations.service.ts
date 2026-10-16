import type {
  AgentMemory,
  AgentMemoryOperation,
  AgentMemoryOperationProposal,
  AgentMemoryWritingPolicy,
  ChatMemoryOperationProjection,
} from '@haohaoxue/lexora-contracts'
import type {
  AgentMemoryCandidateKind as PrismaAgentMemoryCandidateKind,
  AgentMemoryOperationAction as PrismaAgentMemoryOperationAction,
} from '@prisma/client'
import { randomUUID } from 'node:crypto'
import {
  AGENT_MEMORY_LANE,
  AGENT_MEMORY_OPERATION_ACTION,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE,
  AGENT_MEMORY_OPERATION_MODE,
  AGENT_MEMORY_OPERATION_REASON_CODE,
  AGENT_MEMORY_SCOPE,
  AGENT_MEMORY_SENSITIVITY,
  AGENT_MEMORY_SOURCE_TYPE,
  AgentMemoryOperationSchema,
  API_ERROR_CODE,
  ChatMemoryOperationProjectionSchema,
} from '@haohaoxue/lexora-contracts'
import {
  Injectable,
  Logger,
} from '@nestjs/common'
import { ChatMessageGenerationStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { apiConflict, apiForbidden, apiNotFound } from '../../utils/api-error'
import { AgentMemoryService } from './agent-memory.service'
import {
  isUnsafeAgentMemoryPayload,
  normalizeAgentMemorySlotKey,
  toAgentMemory,
  toPrismaMemoryLane,
  toPrismaMemoryScope,
} from './agent-memory.utils'

const AUTO_APPLY_MIN_CONFIDENCE = 0.8
const OPERABLE_GENERATION_STATUSES = new Set<ChatMessageGenerationStatus>([
  ChatMessageGenerationStatus.PENDING,
  ChatMessageGenerationStatus.RUNNING,
])

export interface ProcessAgentMemoryOperationProposalsInput {
  userId: string
  sessionId: string
  messageId: string
  generationId: string
  agentProfileId: string | null
  operations: AgentMemoryOperationProposal[]
  memoryWritingPolicy?: AgentMemoryWritingPolicy
}

export interface RollbackAgentMemoryOperationsResult {
  memoryIds: string[]
  restoredMemoryIds: string[]
  dismissedCandidateCount: number
  changed: boolean
}

export interface FinalizeAgentMemoryOperationsResult {
  archivedMemoryIds: string[]
  changed: boolean
}

@Injectable()
export class AgentMemoryOperationsService {
  private readonly logger = new Logger(AgentMemoryOperationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly memories: AgentMemoryService,
  ) {}

  async processOperationProposals(input: ProcessAgentMemoryOperationProposalsInput): Promise<ChatMemoryOperationProjection[]> {
    const operations = input.operations
      .filter(() => input.memoryWritingPolicy?.enabled !== false)
      .map(operation => this.createOperation(input, operation))
    if (operations.length === 0) {
      return []
    }

    await this.assertGenerationOperationRequest(input)

    const projections: ChatMemoryOperationProjection[] = []
    for (const operation of operations) {
      try {
        projections.push(await this.executeOperation(input, await this.groundOperation(input, operation)))
      }
      catch (error) {
        this.logger.warn(`agent memory operation failed: ${formatErrorMessage(error)}`)
        projections.push(this.createProjection(operation, {
          status: 'failed',
          title: '记忆更新失败',
          detail: operation.content ?? operation.query,
          reason: '记忆操作执行失败，请稍后重试。',
          reasonCode: AGENT_MEMORY_OPERATION_REASON_CODE.FAILED,
          memoryIds: [],
          candidateId: null,
        }))
      }
    }

    return projections
  }

  async rollbackGenerationOperations(
    tx: Prisma.TransactionClient,
    generationId: string,
  ): Promise<RollbackAgentMemoryOperationsResult> {
    const normalizedGenerationId = generationId.trim()
    if (!normalizedGenerationId) {
      return createEmptyRollbackResult()
    }

    const memories = await tx.agentMemory.findMany({
      where: {
        sourceGenerationId: normalizedGenerationId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: {
        id: true,
        supersedesMemoryId: true,
      },
    })
    const memoryIds = memories.map(memory => memory.id)
    const restoredMemoryIds = memories
      .map(memory => memory.supersedesMemoryId)
      .filter((memoryId): memoryId is string => Boolean(memoryId))
    const archivedAt = new Date()

    if (memoryIds.length > 0) {
      await tx.agentMemory.updateMany({
        where: {
          id: { in: memoryIds },
          status: 'ACTIVE',
          deletedAt: null,
        },
        data: {
          status: 'ARCHIVED',
          deletedAt: archivedAt,
        },
      })
    }

    if (restoredMemoryIds.length > 0) {
      await tx.agentMemory.updateMany({
        where: {
          id: { in: restoredMemoryIds },
          status: 'ARCHIVED',
          deletedAt: { not: null },
        },
        data: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      })
    }

    const dismissedCandidates = await tx.agentMemoryCandidate.updateMany({
      where: {
        sourceGenerationId: normalizedGenerationId,
        status: 'PENDING',
        deletedAt: null,
      },
      data: {
        status: 'DISMISSED',
        dismissedAt: archivedAt,
      },
    })

    return {
      memoryIds,
      restoredMemoryIds,
      dismissedCandidateCount: dismissedCandidates.count,
      changed: memoryIds.length > 0 || restoredMemoryIds.length > 0 || dismissedCandidates.count > 0,
    }
  }

  async finalizeGenerationOperations(
    tx: Prisma.TransactionClient,
    generationId: string,
    operations: ChatMemoryOperationProjection[],
  ): Promise<FinalizeAgentMemoryOperationsResult> {
    const archivedMemoryIds = [
      ...new Set(operations
        .filter(operation => operation.status === 'applied')
        .flatMap(operation => operation.archivedMemoryIds)),
    ]
    if (archivedMemoryIds.length === 0) {
      return createEmptyFinalizeResult()
    }

    const generation = await tx.chatMessageGeneration.findFirst({
      where: {
        generationId,
        deletedAt: null,
      },
      select: {
        actorUserId: true,
      },
    })
    if (!generation) {
      return createEmptyFinalizeResult()
    }

    const memories = await tx.agentMemory.findMany({
      where: {
        id: { in: archivedMemoryIds },
        ownerUserId: generation.actorUserId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: {
        id: true,
      },
    })
    const activeMemoryIds = memories.map(memory => memory.id)
    if (activeMemoryIds.length === 0) {
      return createEmptyFinalizeResult()
    }

    await tx.agentMemory.updateMany({
      where: {
        id: { in: activeMemoryIds },
        ownerUserId: generation.actorUserId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      data: {
        status: 'ARCHIVED',
        deletedAt: new Date(),
      },
    })

    return {
      archivedMemoryIds: activeMemoryIds,
      changed: true,
    }
  }

  async cleanupRolledBackMemoryIndexes(memoryIds: string[], restoredMemoryIds: string[]): Promise<void> {
    await this.memories.deleteMemoryIndexesBestEffort(memoryIds)
    await this.memories.syncMemoryIndexesBestEffort(restoredMemoryIds)
  }

  async cleanupFinalizedMemoryIndexes(memoryIds: string[]): Promise<void> {
    await this.memories.deleteMemoryIndexesBestEffort(memoryIds)
  }

  private createOperation(
    input: ProcessAgentMemoryOperationProposalsInput,
    proposal: AgentMemoryOperationProposal,
  ): AgentMemoryOperation {
    return AgentMemoryOperationSchema.parse({
      operationId: randomUUID(),
      source: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        generationId: input.generationId,
        userId: input.userId,
      },
      action: proposal.action,
      mode: proposal.mode,
      scope: proposal.scope,
      lane: proposal.lane,
      slotKey: normalizeAgentMemorySlotKey(proposal.slotKey),
      slotValue: proposal.slotValue,
      content: proposal.content,
      summary: proposal.summary,
      query: proposal.query,
      relatedMemoryIds: proposal.relatedMemoryIds,
      confidence: proposal.confidence,
      sensitivity: proposal.sensitivity,
      reason: proposal.reason,
      createdAt: new Date().toISOString(),
    })
  }

  private async groundOperation(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<AgentMemoryOperation> {
    if (!shouldSearchGroundOperation(operation)) {
      return operation
    }

    const relatedMemories = await this.findRelatedMemories(input, operation)
    const relatedMemoryIds = [
      ...new Set([
        ...operation.relatedMemoryIds,
        ...relatedMemories.map(memory => memory.id),
      ]),
    ]

    return AgentMemoryOperationSchema.parse({
      ...operation,
      relatedMemoryIds,
    })
  }

  private async executeOperation(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<ChatMemoryOperationProjection> {
    if (operation.action === AGENT_MEMORY_OPERATION_ACTION.FORGET) {
      return this.executeForgetOperation(input, operation)
    }

    if (
      operation.action === AGENT_MEMORY_OPERATION_ACTION.CREATE
      || operation.action === AGENT_MEMORY_OPERATION_ACTION.APPEND
      || operation.action === AGENT_MEMORY_OPERATION_ACTION.UPDATE
    ) {
      return this.executeWriteOperation(input, operation)
    }

    return this.createProjection(operation, {
      status: 'ignored',
      title: '未更新记忆',
      detail: null,
      reason: operation.reason ?? '当前记忆操作暂不支持自动执行。',
      memoryIds: [],
      candidateId: null,
    })
  }

  private async executeWriteOperation(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<ChatMemoryOperationProjection> {
    if (!operation.content) {
      return this.createProjection(operation, {
        status: 'ignored',
        title: '未更新记忆',
        detail: null,
        reason: '缺少可保存的记忆内容。',
        memoryIds: [],
        candidateId: null,
      })
    }

    if (operation.scope === AGENT_MEMORY_SCOPE.USER_AGENT && !input.agentProfileId) {
      return this.createProjection(operation, {
        status: 'ignored',
        title: '未更新记忆',
        detail: operation.content,
        reason: '当前对话没有绑定 Agent。',
        memoryIds: [],
        candidateId: null,
      })
    }

    if (
      operation.action === AGENT_MEMORY_OPERATION_ACTION.UPDATE
      && !operation.slotKey
      && operation.relatedMemoryIds.length === 0
    ) {
      const reason = '更新记忆需要明确关联已有记忆。'
      const candidateId = await this.createPendingCandidate(input, {
        ...operation,
        mode: AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
      }, reason)
      return this.createProjection({
        ...operation,
        mode: AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
      }, {
        status: 'pending_confirmation',
        title: '待确认记忆',
        detail: operation.content,
        reason,
        memoryIds: [],
        candidateId,
      })
    }

    const requiresConfirmationReason = resolveWriteConfirmationReason(operation, input.memoryWritingPolicy)
    if (requiresConfirmationReason) {
      const candidateId = await this.createPendingCandidate(input, operation, requiresConfirmationReason)
      return this.createProjection({
        ...operation,
        mode: AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
      }, {
        status: 'pending_confirmation',
        title: '待确认记忆',
        detail: operation.content,
        reason: requiresConfirmationReason,
        reasonCode: AGENT_MEMORY_OPERATION_REASON_CODE.SENSITIVE_CONTENT,
        memoryIds: [],
        candidateId,
      })
    }

    const duplicate = operation.slotKey ? null : await this.findDuplicateMemory(input, operation)
    if (duplicate) {
      return this.createProjection(operation, {
        status: 'ignored',
        title: '记忆已存在',
        detail: duplicate.content,
        reason: '已存在相同记忆，未重复保存。',
        displayCode: AGENT_MEMORY_OPERATION_DISPLAY_CODE.EXISTS,
        reasonCode: AGENT_MEMORY_OPERATION_REASON_CODE.DUPLICATE,
        memoryIds: [duplicate.id],
        candidateId: null,
      })
    }

    const memory = await this.memories.createAcceptedMemory(input.userId, {
      scope: operation.scope,
      lane: operation.lane,
      agentProfileId: operation.scope === AGENT_MEMORY_SCOPE.USER_AGENT ? input.agentProfileId : null,
      slotKey: operation.slotKey,
      slotValue: operation.slotValue,
      content: operation.content,
      summary: operation.summary,
      sensitivity: operation.sensitivity,
      confidence: operation.confidence,
      sourceType: AGENT_MEMORY_SOURCE_TYPE.USER_FEEDBACK,
      sourceSessionId: input.sessionId,
      sourceMessageId: input.messageId,
      sourceGenerationId: input.generationId,
    })
    const archivedMemoryIds = [
      ...(memory.sourceGenerationId === input.generationId && memory.supersedesMemoryId ? [memory.supersedesMemoryId] : []),
      ...(operation.action === AGENT_MEMORY_OPERATION_ACTION.UPDATE ? operation.relatedMemoryIds : []),
    ]

    return this.createProjection(operation, {
      status: 'applied',
      title: operation.slotKey ? '已更新记忆' : '已记住',
      detail: memory.content,
      reason: operation.reason,
      memoryIds: [memory.id],
      archivedMemoryIds: [...new Set(archivedMemoryIds)],
      candidateId: null,
    })
  }

  private async executeForgetOperation(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<ChatMemoryOperationProjection> {
    if (operation.relatedMemoryIds.length === 0) {
      const reason = '忘记记忆需要明确关联已有记忆。'
      const candidateId = await this.createPendingCandidate(input, {
        ...operation,
        mode: AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
      }, reason)
      return this.createProjection({
        ...operation,
        mode: AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
      }, {
        status: 'pending_confirmation',
        title: '待确认遗忘',
        detail: operation.query,
        reason,
        reasonCode: AGENT_MEMORY_OPERATION_REASON_CODE.BROAD_FORGET,
        memoryIds: [],
        candidateId,
      })
    }

    const memories = await this.findMemoriesByIds(input, operation)
    if (memories.length === 0) {
      return this.createProjection(operation, {
        status: 'ignored',
        title: '未找到可忘记的记忆',
        detail: operation.query,
        reason: '没有找到匹配的已确认记忆。',
        memoryIds: [],
        candidateId: null,
      })
    }

    const archivedMemoryIds = memories.map(memory => memory.id)

    return this.createProjection(operation, {
      status: 'applied',
      title: '已忘记记忆',
      detail: `已归档 ${archivedMemoryIds.length} 条相关记忆。`,
      reason: operation.reason,
      memoryIds: archivedMemoryIds,
      archivedMemoryIds,
      candidateId: null,
    })
  }

  private async createPendingCandidate(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
    reason: string,
  ): Promise<string> {
    const candidate = await this.prisma.agentMemoryCandidate.create({
      data: {
        ownerUserId: input.userId,
        agentProfileId: operation.scope === AGENT_MEMORY_SCOPE.USER_AGENT ? input.agentProfileId : null,
        sessionId: input.sessionId,
        sourceMessageId: input.messageId,
        sourceGenerationId: input.generationId,
        kind: toPrismaCandidateKind(operation),
        action: toPrismaOperationAction(operation.action),
        mode: 'PENDING_CONFIRMATION',
        status: 'PENDING',
        scope: toPrismaMemoryScope(operation.scope),
        lane: toPrismaMemoryLane(operation.lane),
        slotKey: operation.slotKey,
        slotValue: operation.slotValue,
        content: operation.content ?? operation.query ?? '',
        summary: operation.summary,
        reason,
        confidence: operation.confidence,
        sensitivity: operation.sensitivity === AGENT_MEMORY_SENSITIVITY.SENSITIVE ? 'SENSITIVE' : 'NORMAL',
        relatedMemoryIds: operation.relatedMemoryIds,
        resultMemoryIds: [],
        operation: toJsonValue({
          ...operation,
          mode: AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
        }),
      },
      select: {
        id: true,
      },
    })

    return candidate.id
  }

  private async findDuplicateMemory(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<AgentMemory | null> {
    if (!operation.content) {
      return null
    }

    const memory = await this.prisma.agentMemory.findFirst({
      where: {
        ownerUserId: input.userId,
        scope: toPrismaMemoryScope(operation.scope),
        lane: toPrismaMemoryLane(operation.lane),
        agentProfileId: operation.scope === AGENT_MEMORY_SCOPE.USER_AGENT ? input.agentProfileId : null,
        content: operation.content,
        status: 'ACTIVE',
        deletedAt: null,
      },
    })

    return memory ? toAgentMemory(memory) : null
  }

  private async findRelatedMemories(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<AgentMemory[]> {
    const baseWhere: Prisma.AgentMemoryWhereInput = {
      ownerUserId: input.userId,
      scope: toPrismaMemoryScope(operation.scope),
      lane: toPrismaMemoryLane(operation.lane),
      agentProfileId: operation.scope === AGENT_MEMORY_SCOPE.USER_AGENT ? input.agentProfileId : null,
      status: 'ACTIVE',
      deletedAt: null,
    }
    if (operation.slotKey) {
      const slotMatches = await this.prisma.agentMemory.findMany({
        where: {
          ...baseWhere,
          slotKey: operation.slotKey,
        },
        take: 20,
      })

      if (slotMatches.length > 0) {
        return slotMatches.map(toAgentMemory)
      }
    }

    const terms = createGroundingSearchTerms(operation)
    if (terms.length === 0) {
      return []
    }

    const indexedMatches = await this.prisma.agentMemorySearchIndex.findMany({
      where: {
        AND: [
          { memory: { is: baseWhere } },
          { OR: createSearchIndexConditions(terms) },
        ],
      },
      include: {
        memory: true,
      },
      orderBy: [
        { indexedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 20,
    })

    if (indexedMatches.length > 0) {
      return indexedMatches.map(match => toAgentMemory(match.memory))
    }

    const tableMatches = await this.prisma.agentMemory.findMany({
      where: {
        ...baseWhere,
        OR: createMemoryTextConditions(terms),
      },
      take: 20,
    })

    return tableMatches.map(toAgentMemory)
  }

  private async findMemoriesByIds(
    input: ProcessAgentMemoryOperationProposalsInput,
    operation: AgentMemoryOperation,
  ): Promise<AgentMemory[]> {
    const memories = await this.prisma.agentMemory.findMany({
      where: {
        id: { in: operation.relatedMemoryIds },
        ownerUserId: input.userId,
        scope: toPrismaMemoryScope(operation.scope),
        lane: toPrismaMemoryLane(operation.lane),
        agentProfileId: operation.scope === AGENT_MEMORY_SCOPE.USER_AGENT ? input.agentProfileId : null,
        status: 'ACTIVE',
        deletedAt: null,
      },
      take: 20,
    })

    return memories.map(toAgentMemory)
  }

  private async assertGenerationOperationRequest(input: ProcessAgentMemoryOperationProposalsInput): Promise<void> {
    const generation = await this.prisma.chatMessageGeneration.findFirst({
      where: {
        generationId: input.generationId,
        deletedAt: null,
      },
      select: {
        actorUserId: true,
        sessionId: true,
        triggerUserMessageId: true,
        agentProfileId: true,
        status: true,
      },
    })

    if (!generation) {
      throw apiNotFound(API_ERROR_CODE.CHAT_GENERATION_NOT_FOUND)
    }

    if (!OPERABLE_GENERATION_STATUSES.has(generation.status)) {
      throw apiConflict(API_ERROR_CODE.CHAT_GENERATION_FINISHED)
    }

    if (
      generation.actorUserId !== input.userId
      || generation.sessionId !== input.sessionId
      || generation.triggerUserMessageId !== input.messageId
      || (generation.agentProfileId ?? null) !== input.agentProfileId
    ) {
      throw apiForbidden(API_ERROR_CODE.MEMORY_OPERATION_CONTEXT_MISMATCH)
    }
  }

  private createProjection(
    operation: AgentMemoryOperation,
    input: {
      status: ChatMemoryOperationProjection['status']
      displayCode?: ChatMemoryOperationProjection['displayCode']
      title: string
      detail: string | null
      reason: string | null
      reasonCode?: ChatMemoryOperationProjection['reasonCode']
      memoryIds: string[]
      archivedMemoryIds?: string[]
      candidateId: string | null
    },
  ): ChatMemoryOperationProjection {
    return ChatMemoryOperationProjectionSchema.parse({
      operationId: operation.operationId,
      action: operation.action,
      mode: operation.mode,
      status: input.status,
      scope: operation.scope,
      lane: operation.lane,
      memoryIds: input.memoryIds,
      archivedMemoryIds: input.archivedMemoryIds ?? [],
      candidateId: input.candidateId,
      displayCode: input.displayCode ?? resolveProjectionDisplayCode(operation, input.status),
      reasonCode: input.reasonCode ?? resolveProjectionReasonCode(input.status),
      title: input.title,
      detail: input.detail,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    })
  }
}

function resolveProjectionDisplayCode(
  operation: AgentMemoryOperation,
  status: ChatMemoryOperationProjection['status'],
): ChatMemoryOperationProjection['displayCode'] {
  if (status === 'failed') {
    return AGENT_MEMORY_OPERATION_DISPLAY_CODE.FAILED
  }

  if (status === 'pending_confirmation') {
    return AGENT_MEMORY_OPERATION_DISPLAY_CODE.PENDING
  }

  if (status === 'ignored') {
    return AGENT_MEMORY_OPERATION_DISPLAY_CODE.IGNORED
  }

  if (operation.action === AGENT_MEMORY_OPERATION_ACTION.FORGET) {
    return AGENT_MEMORY_OPERATION_DISPLAY_CODE.FORGOTTEN
  }

  if (operation.action === AGENT_MEMORY_OPERATION_ACTION.UPDATE || operation.slotKey) {
    return AGENT_MEMORY_OPERATION_DISPLAY_CODE.UPDATED
  }

  return AGENT_MEMORY_OPERATION_DISPLAY_CODE.REMEMBERED
}

function resolveProjectionReasonCode(
  status: ChatMemoryOperationProjection['status'],
): ChatMemoryOperationProjection['reasonCode'] {
  if (status === 'failed') {
    return AGENT_MEMORY_OPERATION_REASON_CODE.FAILED
  }

  return null
}

function resolveWriteConfirmationReason(
  operation: AgentMemoryOperation,
  policy?: AgentMemoryWritingPolicy,
): string | null {
  if (!operation.content) {
    return null
  }

  if (
    policy?.requireConfirmationForSensitive !== false
    && operation.sensitivity === AGENT_MEMORY_SENSITIVITY.SENSITIVE
  ) {
    return '内容被识别为敏感记忆，需要用户确认。'
  }

  if (isUnsafeAgentMemoryPayload({
    slotValue: operation.slotValue,
    summary: operation.summary,
    content: operation.content,
  })) {
    return '内容可能包含敏感信息或提示注入风险。'
  }

  if (
    operation.mode === AGENT_MEMORY_OPERATION_MODE.BACKGROUND_SUGGESTION
    && operation.confidence < (policy?.minAutoApplyConfidence ?? AUTO_APPLY_MIN_CONFIDENCE)
  ) {
    return '自动记忆置信度较低，需要用户确认。'
  }

  if (
    operation.mode === AGENT_MEMORY_OPERATION_MODE.BACKGROUND_SUGGESTION
    && operation.action !== AGENT_MEMORY_OPERATION_ACTION.CREATE
    && operation.action !== AGENT_MEMORY_OPERATION_ACTION.APPEND
  ) {
    return '自动记忆会修改或删除已有记忆，需要用户确认。'
  }

  return null
}

function createEmptyRollbackResult(): RollbackAgentMemoryOperationsResult {
  return {
    memoryIds: [],
    restoredMemoryIds: [],
    dismissedCandidateCount: 0,
    changed: false,
  }
}

function createEmptyFinalizeResult(): FinalizeAgentMemoryOperationsResult {
  return {
    archivedMemoryIds: [],
    changed: false,
  }
}

function shouldSearchGroundOperation(operation: AgentMemoryOperation): boolean {
  return operation.action === AGENT_MEMORY_OPERATION_ACTION.CREATE
    || operation.action === AGENT_MEMORY_OPERATION_ACTION.APPEND
}

function createGroundingSearchTerms(operation: AgentMemoryOperation): string[] {
  const source = createSearchSourceValues(operation).join(' ')
  const tokens = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9][\w.:-]*/giu) ?? []
  const terms = createSearchSourceValues(operation).flatMap(value => value.length <= 160 ? [value] : []).concat(tokens.flatMap((token) => {
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) {
      return token.length >= 2 ? [token] : []
    }

    const chars = [...token]
    return [
      token,
      ...Array.from({ length: Math.max(0, chars.length - 1) }, (_, index) => chars.slice(index, index + 2).join('')),
    ]
  }))

  return [...new Set(terms.map(term => term.trim()).filter(term => term.length >= 2))].slice(0, 12)
}

function createSearchSourceValues(operation: AgentMemoryOperation): string[] {
  return [
    operation.query,
    operation.content,
    operation.slotValue,
    operation.summary,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeSearchTerm)
    .filter(value => value.length >= 2)
    .filter((value, index, values) => values.indexOf(value) === index)
}

function createSearchIndexConditions(terms: string[]): Prisma.AgentMemorySearchIndexWhereInput[] {
  return terms.map(term => ({
    searchText: { contains: term, mode: 'insensitive' as const },
  }))
}

function createMemoryTextConditions(keywords: string[]): Prisma.AgentMemoryWhereInput[] {
  return keywords.flatMap(keyword => [
    { content: { contains: keyword, mode: 'insensitive' as const } },
    { summary: { contains: keyword, mode: 'insensitive' as const } },
    { slotValue: { contains: keyword, mode: 'insensitive' as const } },
  ])
}

function normalizeSearchTerm(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function toPrismaOperationAction(action: AgentMemoryOperation['action']): PrismaAgentMemoryOperationAction {
  switch (action) {
    case AGENT_MEMORY_OPERATION_ACTION.APPEND:
      return 'APPEND'
    case AGENT_MEMORY_OPERATION_ACTION.UPDATE:
      return 'UPDATE'
    case AGENT_MEMORY_OPERATION_ACTION.DISABLE:
      return 'DISABLE'
    case AGENT_MEMORY_OPERATION_ACTION.FORGET:
      return 'FORGET'
    case AGENT_MEMORY_OPERATION_ACTION.IGNORE:
      return 'IGNORE'
    case AGENT_MEMORY_OPERATION_ACTION.ASK_USER:
      return 'ASK_USER'
    case AGENT_MEMORY_OPERATION_ACTION.CREATE:
      return 'CREATE'
  }
}

function toPrismaCandidateKind(operation: Pick<AgentMemoryOperation, 'lane' | 'action'>): PrismaAgentMemoryCandidateKind {
  if (operation.action === AGENT_MEMORY_OPERATION_ACTION.FORGET) {
    return 'FORGET_REQUEST'
  }

  switch (operation.lane) {
    case AGENT_MEMORY_LANE.USER_PROFILE:
      return 'PROFILE'
    case AGENT_MEMORY_LANE.USER_PREFERENCE:
      return 'PREFERENCE'
    case AGENT_MEMORY_LANE.USER_FEEDBACK:
      return 'FEEDBACK'
    case AGENT_MEMORY_LANE.PROJECT_REFERENCE:
      return 'PROJECT_REFERENCE'
    case AGENT_MEMORY_LANE.TASK_KNOWLEDGE:
      return 'TASK_KNOWLEDGE'
    case AGENT_MEMORY_LANE.AGENT_PERSONALIZATION:
      return 'PROFILE'
  }
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
