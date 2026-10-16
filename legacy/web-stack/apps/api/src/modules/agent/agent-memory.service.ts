import type {
  AgentMemory,
  AgentMemoryLane,
  AgentMemoryPolicy,
  AgentMemoryRetrievalSnapshot,
  AgentMemoryScope,
  AgentMemorySensitivity,
  AgentMemorySourceType,
  RetrieveAgentMemoryRequest,
  RetrieveAgentMemoryResponse,
} from '@haohaoxue/lexora-contracts'
import type {
  AgentMemory as PrismaAgentMemory,
  AgentMemoryLane as PrismaAgentMemoryLane,
  AgentMemoryScope as PrismaAgentMemoryScope,
} from '@prisma/client'
import {
  AGENT_MEMORY_LANE,
  AGENT_MEMORY_LANE_VALUES,
  AGENT_MEMORY_SCOPE,
  AgentMemoryPolicySchema,
  AgentMemoryRetrievalSnapshotSchema,
  RetrieveAgentMemoryResponseSchema,
} from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ChatMessageGenerationStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { AgentMemoryIndexingService } from './agent-memory-indexing.service'
import {
  estimateAgentMemoryTokens,
  getAgentMemoryLaneTitle,
  isUnsafeAgentMemoryPayload,
  normalizeAgentMemorySlotKey,
  toAgentMemory,
  toDomainMemoryLane,
  toPrismaMemoryLane,
  toPrismaMemoryScope,
  toPrismaMemorySensitivity,
  toPrismaMemorySourceType,
} from './agent-memory.utils'

const PINNED_MEMORY_LANES = new Set<AgentMemoryLane>([
  AGENT_MEMORY_LANE.AGENT_PERSONALIZATION,
  AGENT_MEMORY_LANE.USER_PROFILE,
  AGENT_MEMORY_LANE.USER_PREFERENCE,
  AGENT_MEMORY_LANE.USER_FEEDBACK,
])
const RETRIEVED_MEMORY_LANES = new Set<AgentMemoryLane>([
  AGENT_MEMORY_LANE.PROJECT_REFERENCE,
  AGENT_MEMORY_LANE.TASK_KNOWLEDGE,
])

const DEFAULT_PINNED_LANE_TOP_K = 20
const DEFAULT_RETRIEVED_LANE_TOP_K = 2
const SLOT_KEY_RE = /^[a-z][a-z0-9_.:-]{1,119}$/
const RETRIEVABLE_GENERATION_STATUSES = new Set<ChatMessageGenerationStatus>([
  ChatMessageGenerationStatus.PENDING,
  ChatMessageGenerationStatus.RUNNING,
])

interface CreateAcceptedMemoryInput {
  scope: AgentMemoryScope
  lane: AgentMemoryLane
  agentProfileId?: string | null
  slotKey?: string | null
  slotValue?: string | null
  content: string
  summary?: string | null
  sensitivity: AgentMemorySensitivity
  confidence: number
  sourceType: AgentMemorySourceType
  sourceSessionId?: string | null
  sourceMessageId?: string | null
  sourceGenerationId?: string | null
}

interface FindTextMemoriesInput {
  where: Prisma.AgentMemoryWhereInput
  actorUserId: string
  agentProfileId: string | null
  scopes: PrismaAgentMemoryScope[]
  lanes: AgentMemoryLane[]
  includeSensitive: boolean
  query: string
}

@Injectable()
export class AgentMemoryService {
  private readonly logger = new Logger(AgentMemoryService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexing: AgentMemoryIndexingService,
  ) {}

  async createAcceptedMemory(userId: string, payload: CreateAcceptedMemoryInput): Promise<AgentMemory> {
    const scope = toPrismaMemoryScope(payload.scope)
    const lane = toPrismaMemoryLane(payload.lane)
    const agentProfileId = await this.resolveAgentProfileId({
      userId,
      scope,
      agentProfileId: payload.agentProfileId ?? null,
    })
    const slotKey = normalizeAgentMemorySlotKey(payload.slotKey)

    assertSlotKey(slotKey)
    assertMemoryContentSafe(payload)

    let archivedMemoryIds: string[] = []
    let memory: PrismaAgentMemory | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      archivedMemoryIds = []
      try {
        memory = await this.prisma.$transaction(async (tx) => {
          const existingSlotMemory = slotKey
            ? await this.findActiveSlotMemory(tx, {
                ownerUserId: userId,
                scope,
                lane,
                agentProfileId,
                slotKey,
              })
            : null

          if (existingSlotMemory && isSameSlotValue(existingSlotMemory, payload)) {
            return existingSlotMemory
          }

          if (existingSlotMemory) {
            await tx.agentMemory.update({
              where: { id: existingSlotMemory.id },
              data: {
                status: 'ARCHIVED',
                deletedAt: new Date(),
              },
            })
            archivedMemoryIds.push(existingSlotMemory.id)
          }

          return tx.agentMemory.create({
            data: {
              scope,
              lane,
              ownerUserId: userId,
              workspaceId: null,
              agentProfileId,
              slotKey,
              slotValue: normalizeNullableText(payload.slotValue),
              content: payload.content.trim(),
              summary: normalizeNullableText(payload.summary),
              sensitivity: toPrismaMemorySensitivity(payload.sensitivity),
              confidence: payload.confidence,
              sourceType: toPrismaMemorySourceType(payload.sourceType),
              sourceSessionId: normalizeNullableText(payload.sourceSessionId),
              sourceMessageId: normalizeNullableText(payload.sourceMessageId),
              sourceGenerationId: normalizeNullableText(payload.sourceGenerationId),
              status: 'ACTIVE',
              supersedesMemoryId: existingSlotMemory?.id ?? null,
              createdByUserId: userId,
              acceptedByUserId: userId,
            },
          })
        })
        break
      }
      catch (error) {
        if (!isUniqueConstraintError(error) || attempt > 0) {
          throw error
        }
      }
    }

    if (!memory) {
      throw new BadRequestException('记忆写入失败')
    }

    await Promise.all(archivedMemoryIds.map(memoryId => this.deleteMemoryIndexBestEffort(memoryId)))
    await this.syncMemoryIndexBestEffort(memory)

    return toAgentMemory(memory)
  }

  async archiveMemory(userId: string, memoryId: string): Promise<void> {
    const archivedMemoryIds = await this.archiveMemories(userId, [memoryId])

    if (archivedMemoryIds.length === 0) {
      throw new NotFoundException('记忆不存在')
    }
  }

  async archiveMemories(userId: string, memoryIds: string[]): Promise<string[]> {
    const uniqueMemoryIds = [...new Set(memoryIds.map(memoryId => memoryId.trim()).filter(Boolean))]
    if (uniqueMemoryIds.length === 0) {
      return []
    }

    const archivedMemoryIds = await this.prisma.$transaction(async (tx) => {
      const memories = await tx.agentMemory.findMany({
        where: {
          id: { in: uniqueMemoryIds },
          ownerUserId: userId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      })
      const activeMemoryIds = memories.map(memory => memory.id)

      if (activeMemoryIds.length === 0) {
        return []
      }

      await tx.agentMemory.updateMany({
        where: {
          id: { in: activeMemoryIds },
          ownerUserId: userId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        data: {
          status: 'ARCHIVED',
          deletedAt: new Date(),
        },
      })

      return activeMemoryIds
    })

    await Promise.all(archivedMemoryIds.map(memoryId => this.deleteMemoryIndexBestEffort(memoryId)))

    return archivedMemoryIds
  }

  async deleteMemoryIndexesBestEffort(memoryIds: string[]): Promise<void> {
    await Promise.all([...new Set(memoryIds)].map(memoryId => this.deleteMemoryIndexBestEffort(memoryId)))
  }

  async syncMemoryIndexesBestEffort(memoryIds: string[]): Promise<void> {
    const uniqueMemoryIds = [...new Set(memoryIds.map(memoryId => memoryId.trim()).filter(Boolean))]
    if (uniqueMemoryIds.length === 0) {
      return
    }

    const memories = await this.prisma.agentMemory.findMany({
      where: {
        id: { in: uniqueMemoryIds },
        status: 'ACTIVE',
        deletedAt: null,
      },
    })

    await Promise.all(memories.map(memory => this.syncMemoryIndexBestEffort(memory)))
  }

  async retrieveMemoriesForAgent(payload: RetrieveAgentMemoryRequest): Promise<RetrieveAgentMemoryResponse> {
    await this.assertGenerationMemoryRequest(payload)

    const policy = AgentMemoryPolicySchema.parse(payload.policy)
    if (!policy.enabled || policy.ignoredForRun) {
      return RetrieveAgentMemoryResponseSchema.parse({
        snapshot: createDisabledSnapshot(policy, payload.query),
      })
    }

    const scopes = resolveAllowedScopes(policy, payload.agentProfileId)
    const lanes = policy.lanes.length > 0 ? policy.lanes : [...AGENT_MEMORY_LANE_VALUES]

    if (scopes.length === 0 || lanes.length === 0) {
      return RetrieveAgentMemoryResponseSchema.parse({
        snapshot: createDisabledSnapshot(policy, payload.query),
      })
    }

    const where = createRetrievalWhere({
      actorUserId: payload.actorUserId,
      agentProfileId: payload.agentProfileId,
      scopes: scopes.map(toPrismaMemoryScope),
      lanes: lanes.map(toPrismaMemoryLane),
      includeSensitive: policy.includeSensitive,
    })
    const pinnedLanes = lanes.filter(lane => PINNED_MEMORY_LANES.has(lane))
    const retrievedLanes = lanes.filter(lane => RETRIEVED_MEMORY_LANES.has(lane))

    if (!await this.hasActiveMemory(where)) {
      return RetrieveAgentMemoryResponseSchema.parse({
        snapshot: createEmptySnapshot(policy, payload.query, scopes, lanes),
      })
    }

    const [pinnedMemories, textMemories] = await Promise.all([
      this.findPinnedMemories(where, pinnedLanes),
      this.findTextMemories({
        where,
        actorUserId: payload.actorUserId,
        agentProfileId: payload.agentProfileId,
        scopes: scopes.map(toPrismaMemoryScope),
        lanes: retrievedLanes,
        includeSensitive: policy.includeSensitive,
        query: payload.query,
      }),
    ])
    const selected = selectMemoriesForPrompt({
      memories: dedupeMemories([...pinnedMemories, ...textMemories]),
      policy,
    })
    const snapshot = AgentMemoryRetrievalSnapshotSchema.parse({
      enabled: true,
      ignoredForRun: false,
      query: payload.query,
      scopes,
      lanes,
      selectedMemoryIds: selected.memories.map(memory => memory.id),
      omittedMemoryIds: selected.omittedMemoryIds,
      injectedCount: selected.memories.length,
      estimatedTokens: selected.estimatedTokens,
      budgetTokens: policy.maxInjectedTokens,
      retriever: resolveRetriever(pinnedMemories.length, textMemories.length),
      renderedSections: createRenderedSections(selected.memories),
      createdAt: new Date().toISOString(),
    })

    if (snapshot.selectedMemoryIds.length > 0) {
      await this.touchMemoryLastUsedAt(payload.actorUserId, snapshot.selectedMemoryIds)
    }

    return RetrieveAgentMemoryResponseSchema.parse({ snapshot })
  }

  private async resolveAgentProfileId(input: {
    userId: string
    scope: PrismaAgentMemoryScope
    agentProfileId: string | null
  }): Promise<string | null> {
    if (input.scope === 'USER') {
      return null
    }

    const agentProfileId = input.agentProfileId?.trim()
    if (!agentProfileId) {
      throw new BadRequestException('USER_AGENT 记忆必须绑定 AgentProfile')
    }

    const profile = await this.prisma.agentProfile.findFirst({
      where: {
        id: agentProfileId,
        ownerUserId: input.userId,
        deletedAt: null,
      },
      select: { id: true },
    })

    if (!profile) {
      throw new NotFoundException('AgentProfile 不存在')
    }

    return profile.id
  }

  private async assertGenerationMemoryRequest(payload: RetrieveAgentMemoryRequest): Promise<void> {
    const generation = await this.prisma.chatMessageGeneration.findFirst({
      where: {
        generationId: payload.generationId,
        deletedAt: null,
      },
      select: {
        actorUserId: true,
        sessionId: true,
        agentProfileId: true,
        status: true,
      },
    })

    if (!generation) {
      throw new NotFoundException('聊天生成不存在')
    }

    if (!RETRIEVABLE_GENERATION_STATUSES.has(generation.status)) {
      throw new ConflictException('聊天生成已结束')
    }

    if (
      generation.actorUserId !== payload.actorUserId
      || generation.sessionId !== payload.sessionId
      || (generation.agentProfileId ?? null) !== payload.agentProfileId
    ) {
      throw new ForbiddenException('记忆检索上下文不匹配')
    }
  }

  private async hasActiveMemory(where: Prisma.AgentMemoryWhereInput): Promise<boolean> {
    const memory = await this.prisma.agentMemory.findFirst({
      where,
      select: { id: true },
    })

    return Boolean(memory)
  }

  private async touchMemoryLastUsedAt(ownerUserId: string, memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return
    }

    await this.prisma.$executeRaw`
      UPDATE "AgentMemory"
      SET "lastUsedAt" = ${new Date()}
      WHERE "ownerUserId" = ${ownerUserId}
        AND "id" IN (${Prisma.join(memoryIds)})
    `
  }

  private findActiveSlotMemory(
    client: Pick<Prisma.TransactionClient, 'agentMemory'>,
    input: {
      ownerUserId: string
      scope: PrismaAgentMemoryScope
      lane: PrismaAgentMemoryLane
      agentProfileId: string | null
      slotKey: string
      excludeMemoryId?: string
    },
  ): Promise<PrismaAgentMemory | null> {
    return client.agentMemory.findFirst({
      where: {
        ownerUserId: input.ownerUserId,
        scope: input.scope,
        lane: input.lane,
        agentProfileId: input.agentProfileId,
        slotKey: input.slotKey,
        status: 'ACTIVE',
        deletedAt: null,
        ...(input.excludeMemoryId ? { id: { not: input.excludeMemoryId } } : {}),
      },
    })
  }

  private async findPinnedMemories(
    where: Prisma.AgentMemoryWhereInput,
    lanes: AgentMemoryLane[],
  ): Promise<PrismaAgentMemory[]> {
    if (lanes.length === 0) {
      return Promise.resolve([])
    }

    const memories = await Promise.all(lanes.map(lane => this.prisma.agentMemory.findMany({
      where: {
        AND: [
          where,
          { lane: toPrismaMemoryLane(lane) },
        ],
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: DEFAULT_PINNED_LANE_TOP_K,
    })))

    return memories.flat()
  }

  private async findTextMemories(input: FindTextMemoriesInput): Promise<PrismaAgentMemory[]> {
    if (input.lanes.length === 0) {
      return Promise.resolve([])
    }

    const vectorMemories = await this.findVectorMemories(input)
    if (vectorMemories.length > 0) {
      return vectorMemories
    }

    const terms = createMemorySearchTerms(input.query)
    if (terms.length === 0) {
      return Promise.resolve([])
    }

    const results = await this.prisma.agentMemorySearchIndex.findMany({
      where: {
        AND: [
          { memory: { is: input.where } },
          { lane: { in: input.lanes.map(toPrismaMemoryLane) } },
          {
            OR: terms.map(term => ({
              searchText: { contains: term, mode: 'insensitive' as const },
            })),
          },
        ],
      },
      include: {
        memory: true,
      },
      orderBy: [
        { indexedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 50,
    })

    return results.map(result => result.memory)
  }

  private async findVectorMemories(input: FindTextMemoriesInput): Promise<PrismaAgentMemory[]> {
    const query = input.query.trim()
    if (!query || input.scopes.length === 0 || input.lanes.length === 0) {
      return []
    }

    const embedding = await this.indexing.createQueryEmbedding(input.actorUserId, query)
    if (!embedding) {
      return []
    }

    try {
      return await this.prisma.$queryRaw<PrismaAgentMemory[]>(Prisma.sql`
        SELECT m.*
        FROM "AgentMemorySearchIndex" i
        INNER JOIN "AgentMemory" m ON m."id" = i."memoryId"
        WHERE i."embedding" IS NOT NULL
          AND i."embeddingDimensions" = ${embedding.length}
          AND m."ownerUserId" = ${input.actorUserId}
          AND m."scope"::text IN (${Prisma.join(input.scopes)})
          AND m."lane"::text IN (${Prisma.join(input.lanes.map(toPrismaMemoryLane))})
          AND m."status"::text = 'ACTIVE'
          AND m."deletedAt" IS NULL
          AND (m."expiresAt" IS NULL OR m."expiresAt" > NOW())
          ${input.includeSensitive ? Prisma.empty : Prisma.sql`AND m."sensitivity"::text = 'NORMAL'`}
          ${input.agentProfileId
            ? Prisma.sql`AND (m."scope"::text = 'USER' OR (m."scope"::text = 'USER_AGENT' AND m."agentProfileId" = ${input.agentProfileId}))`
            : Prisma.sql`AND m."scope"::text = 'USER'`}
        ORDER BY i."embedding" <=> ${formatVectorLiteral(embedding)}::vector, i."indexedAt" DESC
        LIMIT 50
      `)
    }
    catch {
      return []
    }
  }

  private async syncMemoryIndexBestEffort(memory: PrismaAgentMemory): Promise<void> {
    try {
      await this.indexing.syncMemoryIndex(memory)
    }
    catch (error) {
      this.logger.warn(`agent memory index sync failed: ${formatErrorMessage(error)}`)
    }
  }

  private async deleteMemoryIndexBestEffort(memoryId: string): Promise<void> {
    try {
      await this.indexing.deleteMemoryIndex(memoryId)
    }
    catch (error) {
      this.logger.warn(`agent memory index delete failed: ${formatErrorMessage(error)}`)
    }
  }
}

function createRetrievalWhere(input: {
  actorUserId: string
  agentProfileId: string | null
  scopes: PrismaAgentMemoryScope[]
  lanes: PrismaAgentMemoryLane[]
  includeSensitive: boolean
}): Prisma.AgentMemoryWhereInput {
  return {
    ownerUserId: input.actorUserId,
    scope: { in: input.scopes },
    lane: { in: input.lanes },
    status: 'ACTIVE',
    deletedAt: null,
    AND: [
      {
        OR: [
          { scope: 'USER' },
          ...(input.agentProfileId
            ? [{ scope: 'USER_AGENT' as const, agentProfileId: input.agentProfileId }]
            : []),
        ],
      },
      {
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
    ],
    ...(input.includeSensitive ? {} : { sensitivity: 'NORMAL' }),
  }
}

function resolveAllowedScopes(policy: AgentMemoryPolicy, agentProfileId: string | null) {
  return policy.scopes.filter(scope => scope === AGENT_MEMORY_SCOPE.USER || (scope === AGENT_MEMORY_SCOPE.USER_AGENT && agentProfileId))
}

function createDisabledSnapshot(policy: AgentMemoryPolicy, query: string): AgentMemoryRetrievalSnapshot {
  return AgentMemoryRetrievalSnapshotSchema.parse({
    enabled: policy.enabled,
    ignoredForRun: policy.ignoredForRun,
    query,
    scopes: policy.scopes,
    lanes: policy.lanes,
    selectedMemoryIds: [],
    omittedMemoryIds: [],
    injectedCount: 0,
    estimatedTokens: 0,
    budgetTokens: policy.maxInjectedTokens,
    retriever: 'disabled',
    renderedSections: [],
    createdAt: new Date().toISOString(),
  })
}

function createEmptySnapshot(
  policy: AgentMemoryPolicy,
  query: string,
  scopes: AgentMemoryScope[],
  lanes: AgentMemoryLane[],
): AgentMemoryRetrievalSnapshot {
  return AgentMemoryRetrievalSnapshotSchema.parse({
    enabled: true,
    ignoredForRun: false,
    query,
    scopes,
    lanes,
    selectedMemoryIds: [],
    omittedMemoryIds: [],
    injectedCount: 0,
    estimatedTokens: 0,
    budgetTokens: policy.maxInjectedTokens,
    retriever: 'none',
    renderedSections: [],
    createdAt: new Date().toISOString(),
  })
}

function dedupeMemories(memories: PrismaAgentMemory[]): PrismaAgentMemory[] {
  const seen = new Set<string>()
  const result: PrismaAgentMemory[] = []

  for (const memory of memories) {
    if (seen.has(memory.id)) {
      continue
    }

    seen.add(memory.id)
    result.push(memory)
  }

  return result
}

function selectMemoriesForPrompt(input: {
  memories: PrismaAgentMemory[]
  policy: AgentMemoryPolicy
}) {
  const laneCounts = new Map<AgentMemoryLane, number>()
  const laneTokens = new Map<AgentMemoryLane, number>()
  const selected: PrismaAgentMemory[] = []
  const omittedMemoryIds: string[] = []
  let totalTokens = 0

  for (const memory of input.memories) {
    const lane = toDomainMemoryLane(memory.lane)
    const itemTokens = estimateAgentMemoryTokens(memory.content)
    const maxLaneCount = input.policy.perLaneTopK[lane] ?? getDefaultLaneTopK(lane)
    const maxLaneTokens = input.policy.perLaneBudget[lane] ?? input.policy.maxInjectedTokens
    const currentLaneCount = laneCounts.get(lane) ?? 0
    const currentLaneTokens = laneTokens.get(lane) ?? 0

    if (
      currentLaneCount >= maxLaneCount
      || currentLaneTokens + itemTokens > maxLaneTokens
      || totalTokens + itemTokens > input.policy.maxInjectedTokens
      || shouldOmitMemory(memory)
    ) {
      omittedMemoryIds.push(memory.id)
      continue
    }

    selected.push(memory)
    totalTokens += itemTokens
    laneCounts.set(lane, currentLaneCount + 1)
    laneTokens.set(lane, currentLaneTokens + itemTokens)
  }

  return {
    memories: selected,
    omittedMemoryIds,
    estimatedTokens: totalTokens,
  }
}

function createRenderedSections(memories: PrismaAgentMemory[]) {
  const sections = new Map<AgentMemoryLane, PrismaAgentMemory[]>()

  for (const memory of memories) {
    const lane = toDomainMemoryLane(memory.lane)
    sections.set(lane, [...(sections.get(lane) ?? []), memory])
  }

  return [...sections.entries()].map(([lane, items]) => ({
    lane,
    title: getAgentMemoryLaneTitle(lane),
    items: items.map(memory => ({
      memoryId: memory.id,
      content: memory.content,
      score: null,
      slotKey: memory.slotKey,
    })),
  }))
}

function getDefaultLaneTopK(lane: AgentMemoryLane): number {
  return PINNED_MEMORY_LANES.has(lane) ? DEFAULT_PINNED_LANE_TOP_K : DEFAULT_RETRIEVED_LANE_TOP_K
}

function resolveRetriever(pinnedCount: number, textCount: number): AgentMemoryRetrievalSnapshot['retriever'] {
  if (pinnedCount > 0 && textCount > 0) {
    return 'pinned+text'
  }
  if (pinnedCount > 0) {
    return 'pinned'
  }
  if (textCount > 0) {
    return 'text'
  }
  return 'none'
}

function assertSlotKey(slotKey: string | null): void {
  if (slotKey && !SLOT_KEY_RE.test(slotKey)) {
    throw new BadRequestException('slotKey 只能使用小写字母、数字、点、冒号、下划线或短横线')
  }
}

function assertMemoryContentSafe(payload: Pick<CreateAcceptedMemoryInput, 'content' | 'summary' | 'slotValue'>): void {
  if (shouldOmitMemoryPayload(payload)) {
    throw new BadRequestException('记忆内容包含不能保存的安全风险')
  }
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function formatVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

function isSameSlotValue(memory: PrismaAgentMemory, payload: Pick<CreateAcceptedMemoryInput, 'content' | 'slotValue'>): boolean {
  const nextSlotValue = normalizeNullableText(payload.slotValue)
  return memory.slotValue === nextSlotValue && memory.content.trim() === payload.content.trim()
}

function shouldOmitMemory(memory: PrismaAgentMemory): boolean {
  return shouldOmitMemoryPayload(memory)
}

function shouldOmitMemoryPayload(memory: {
  slotValue?: string | null
  summary?: string | null
  content: string
}): boolean {
  return isUnsafeAgentMemoryPayload(memory)
}

function createMemorySearchTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase()
  const terms = new Set<string>()

  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9][\w.:-]*/giu)) {
    const value = match[0]
    if (isCjkLikeText(value)) {
      addCjkSearchTerms(terms, value)
    }
    else if (value.length >= 2) {
      terms.add(value)
    }

    if (terms.size >= 12) {
      break
    }
  }

  return [...terms].slice(0, 12)
}

function addCjkSearchTerms(terms: Set<string>, value: string): void {
  const chars = [...value]
  if (chars.length < 2) {
    return
  }

  if (chars.length <= 8) {
    terms.add(chars.join(''))
  }

  for (let index = 0; index < chars.length - 1 && terms.size < 12; index += 1) {
    terms.add(chars.slice(index, index + 2).join(''))
  }
}

function isCjkLikeText(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
