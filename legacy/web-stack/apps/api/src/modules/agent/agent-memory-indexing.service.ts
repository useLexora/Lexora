import type { AgentMemory as PrismaAgentMemory } from '@prisma/client'
import { createHash } from 'node:crypto'
import { AI_MODEL_INTENT_KEY } from '@haohaoxue/lexora-contracts'
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { AiModelResolverService } from '../ai/models/resolver.service'
import { buildAgentMemorySearchText } from './agent-memory.utils'

const EMBEDDING_REQUEST_TIMEOUT_MS = 15_000
const TRAILING_SLASHES_RE = /\/+$/

interface MemoryEmbedding {
  vector: number[]
  providerKey: string
  modelId: string
  dimensions: number
}

@Injectable()
export class AgentMemoryIndexingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modelResolver: AiModelResolverService,
  ) {}

  async syncMemoryIndex(memory: PrismaAgentMemory): Promise<void> {
    const searchText = buildAgentMemorySearchText(memory)
    const contentHash = createHash('sha256').update(searchText).digest('hex')
    const existingIndex = await this.prisma.agentMemorySearchIndex.findUnique({
      where: {
        memoryId: memory.id,
      },
      select: {
        contentHash: true,
      },
    })

    await this.prisma.agentMemorySearchIndex.upsert({
      where: {
        memoryId: memory.id,
      },
      create: {
        memoryId: memory.id,
        scope: memory.scope,
        lane: memory.lane,
        ownerUserId: memory.ownerUserId,
        workspaceId: memory.workspaceId,
        agentProfileId: memory.agentProfileId,
        searchText,
        contentHash,
        indexedAt: new Date(),
      },
      update: {
        scope: memory.scope,
        lane: memory.lane,
        ownerUserId: memory.ownerUserId,
        workspaceId: memory.workspaceId,
        agentProfileId: memory.agentProfileId,
        searchText,
        contentHash,
        indexedAt: new Date(),
      },
    })

    const embedding = await this.createEmbedding(memory.ownerUserId, searchText)
    if (embedding) {
      await this.updateMemoryEmbedding(memory.id, embedding)
      return
    }

    if (existingIndex && existingIndex.contentHash !== contentHash) {
      await this.clearMemoryEmbedding(memory.id)
    }
  }

  async deleteMemoryIndex(memoryId: string): Promise<void> {
    await this.prisma.$bypass.agentMemorySearchIndex.deleteMany({
      where: { memoryId },
    })
  }

  async createQueryEmbedding(ownerUserId: string, text: string): Promise<number[] | null> {
    const embedding = await this.createEmbedding(ownerUserId, text)
    return embedding?.vector ?? null
  }

  private async createEmbedding(ownerUserId: string, text: string): Promise<MemoryEmbedding | null> {
    try {
      const target = await this.modelResolver.resolveModelTarget({
        actorUserId: ownerUserId,
        intentKey: AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT,
      })
      const vector = await this.fetchEmbedding(target, text)

      return {
        vector,
        providerKey: target.providerKey,
        modelId: target.modelId,
        dimensions: vector.length,
      }
    }
    catch {
      return null
    }
  }

  private async fetchEmbedding(
    target: Awaited<ReturnType<AiModelResolverService['resolveModelTarget']>>,
    text: string,
  ): Promise<number[]> {
    const response = await fetch(`${target.endpoint.replace(TRAILING_SLASHES_RE, '')}/embeddings`, {
      method: 'POST',
      headers: createEmbeddingRequestHeaders(target),
      body: JSON.stringify({
        model: target.modelId,
        input: text,
      }),
      signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`embedding request failed: HTTP ${response.status}`)
    }

    const payload = await response.json().catch(() => null)
    return parseEmbeddingResponse(payload)
  }

  private async updateMemoryEmbedding(memoryId: string, embedding: MemoryEmbedding): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "AgentMemorySearchIndex"
      SET
        "embedding" = ${formatVectorLiteral(embedding.vector)}::vector,
        "embeddingModelProviderKey" = ${embedding.providerKey},
        "embeddingModelId" = ${embedding.modelId},
        "embeddingDimensions" = ${embedding.dimensions}
      WHERE "memoryId" = ${memoryId}
    `)
  }

  private async clearMemoryEmbedding(memoryId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "AgentMemorySearchIndex"
      SET
        "embedding" = NULL,
        "embeddingModelProviderKey" = NULL,
        "embeddingModelId" = NULL,
        "embeddingDimensions" = NULL
      WHERE "memoryId" = ${memoryId}
    `)
  }
}

function createEmbeddingRequestHeaders(
  target: Awaited<ReturnType<AiModelResolverService['resolveModelTarget']>>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'accept': 'application/json',
    'content-type': 'application/json',
  }

  if (target.authMode === 'bearer' && target.apiKey) {
    headers.authorization = `Bearer ${target.apiKey}`
  }
  if (target.authMode === 'api-key' && target.apiKey) {
    headers['x-api-key'] = target.apiKey
  }

  return headers
}

function parseEmbeddingResponse(payload: unknown): number[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('embedding response is invalid')
  }

  const first = payload.data.find(isRecord)
  if (!first || !Array.isArray(first.embedding)) {
    throw new Error('embedding response is missing vector')
  }

  const vector = first.embedding.map(value => typeof value === 'number' ? value : Number(value))
  if (vector.length === 0 || vector.some(value => !Number.isFinite(value))) {
    throw new Error('embedding vector is invalid')
  }

  return vector
}

function formatVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
