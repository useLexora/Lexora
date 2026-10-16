import type {
  AgentMemory,
  AgentMemoryDocument,
  AgentMemoryDocumentId,
  AgentMemoryDocumentsResponse,
  AgentMemoryLane,
  ListAgentMemoryDocumentsQuery,
} from '@haohaoxue/lexora-contracts'
import { Buffer } from 'node:buffer'
import {
  AGENT_MEMORY_DOCUMENT_ID,
  AGENT_MEMORY_LANE,
  AgentMemoryDocumentSchema,
  AgentMemoryDocumentsResponseSchema,
} from '@haohaoxue/lexora-contracts'
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import {
  toAgentMemory,
} from './agent-memory.utils'

interface MemoryDocumentDefinition {
  id: AgentMemoryDocumentId
  name: string
  summary: string
  blocks: MemoryDocumentBlockDefinition[]
}

interface MemoryDocumentBlockDefinition {
  heading: string
  lanes: AgentMemoryLane[]
}

const MEMORY_DOCUMENT_DEFINITIONS: MemoryDocumentDefinition[] = [
  {
    id: AGENT_MEMORY_DOCUMENT_ID.SOUL,
    name: 'SOUL.md',
    summary: 'Agent 的身份、性格、说话方式和相处原则',
    blocks: [
      {
        heading: '身份与相处方式',
        lanes: [AGENT_MEMORY_LANE.AGENT_PERSONALIZATION],
      },
    ],
  },
  {
    id: AGENT_MEMORY_DOCUMENT_ID.USER,
    name: 'USER.md',
    summary: '用户画像、偏好、状态和交互习惯',
    blocks: [
      {
        heading: '用户画像',
        lanes: [AGENT_MEMORY_LANE.USER_PROFILE],
      },
      {
        heading: '偏好',
        lanes: [AGENT_MEMORY_LANE.USER_PREFERENCE],
      },
      {
        heading: '反馈与习惯',
        lanes: [AGENT_MEMORY_LANE.USER_FEEDBACK],
      },
    ],
  },
  {
    id: AGENT_MEMORY_DOCUMENT_ID.MEMORY,
    name: 'MEMORY.md',
    summary: '关键任务、事件、概念和注意事项',
    blocks: [
      {
        heading: '项目参考',
        lanes: [AGENT_MEMORY_LANE.PROJECT_REFERENCE],
      },
      {
        heading: '任务知识',
        lanes: [AGENT_MEMORY_LANE.TASK_KNOWLEDGE],
      },
    ],
  },
]

@Injectable()
export class AgentMemoryDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listDocuments(userId: string, query: ListAgentMemoryDocumentsQuery = {}): Promise<AgentMemoryDocumentsResponse> {
    const agentProfileId = await this.resolveAgentProfileId(userId, query.agentProfileId)
    const memories = await this.findActiveMemories(userId, agentProfileId)

    return AgentMemoryDocumentsResponseSchema.parse({
      documents: MEMORY_DOCUMENT_DEFINITIONS.map(definition => createMemoryDocument(definition, memories)),
    })
  }

  async getDocument(userId: string, documentId: AgentMemoryDocumentId, query: ListAgentMemoryDocumentsQuery = {}): Promise<AgentMemoryDocument> {
    const definition = MEMORY_DOCUMENT_DEFINITIONS.find(item => item.id === documentId)
    if (!definition) {
      throw new NotFoundException('记忆文档不存在')
    }

    const agentProfileId = await this.resolveAgentProfileId(userId, query.agentProfileId)
    const memories = await this.findActiveMemories(userId, agentProfileId)
    const document = createMemoryDocument(definition, memories)

    return AgentMemoryDocumentSchema.parse(document)
  }

  private async resolveAgentProfileId(userId: string, agentProfileId: string | undefined): Promise<string | null> {
    const normalized = agentProfileId?.trim()
    if (!normalized) {
      return null
    }

    const profile = await this.prisma.agentProfile.findFirst({
      where: {
        id: normalized,
        ownerUserId: userId,
        deletedAt: null,
      },
      select: { id: true },
    })

    if (!profile) {
      throw new NotFoundException('AgentProfile 不存在')
    }

    return profile.id
  }

  private async findActiveMemories(userId: string, agentProfileId: string | null): Promise<AgentMemory[]> {
    const now = new Date()
    const memories = await this.prisma.agentMemory.findMany({
      where: {
        ownerUserId: userId,
        status: 'ACTIVE',
        deletedAt: null,
        AND: [
          {
            OR: [
              { scope: 'USER' },
              ...(agentProfileId
                ? [{ scope: 'USER_AGENT' as const, agentProfileId }]
                : []),
            ],
          },
          {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
        ],
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    })

    return memories.map(toAgentMemory)
  }
}

function createMemoryDocument(
  definition: MemoryDocumentDefinition,
  memories: AgentMemory[],
): AgentMemoryDocument {
  const documentMemories = pickDocumentMemories(definition, memories)
  const content = renderMemoryDocument(definition, documentMemories)
  const sourceMemoryIds = documentMemories.map(memory => memory.id)

  return {
    id: definition.id,
    name: definition.name,
    summary: definition.summary,
    content,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    updatedAt: getLatestUpdatedAt(documentMemories),
    sourceMemoryIds,
  }
}

function pickDocumentMemories(
  definition: MemoryDocumentDefinition,
  memories: AgentMemory[],
): AgentMemory[] {
  const lanes = new Set(definition.blocks.flatMap(block => block.lanes))

  return memories.filter(memory => lanes.has(memory.lane))
}

function renderMemoryDocument(
  definition: MemoryDocumentDefinition,
  memories: AgentMemory[],
): string {
  if (memories.length === 0) {
    return ''
  }

  const blocks = definition.blocks
    .map(block => ({
      heading: block.heading,
      memories: memories.filter(memory => block.lanes.includes(memory.lane)),
    }))
    .filter(block => block.memories.length > 0)

  if (memories.length <= 2 || blocks.length <= 1) {
    return memories.map(formatMemoryMarkdownText).join('\n\n')
  }

  return blocks.map(renderMemoryBlock).join('\n\n')
}

function renderMemoryBlock(block: { heading: string, memories: AgentMemory[] }): string {
  return [
    `## ${block.heading}`,
    '',
    ...block.memories.map(memory => `- ${formatMemoryMarkdownText(memory)}`),
  ].join('\n')
}

function formatMemoryMarkdownText(memory: AgentMemory): string {
  const slotValue = normalizeMemoryText(memory.slotValue ?? '')
  const summary = normalizeMemoryText(memory.summary ?? '')
  const content = normalizeMemoryText(memory.content)
  const text = summary || content

  if (!slotValue || includesNormalizedText(text, slotValue)) {
    return text
  }

  if (!text) {
    return slotValue
  }

  return `${text}：${slotValue}`
}

function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function includesNormalizedText(text: string, value: string): boolean {
  return text.toLocaleLowerCase().includes(value.toLocaleLowerCase())
}

function getLatestUpdatedAt(memories: AgentMemory[]): string | null {
  const latest = memories.reduce<number | null>((result, memory) => {
    const value = Date.parse(memory.updatedAt)
    if (!Number.isFinite(value)) {
      return result
    }

    return result === null ? value : Math.max(result, value)
  }, null)

  return latest === null ? null : new Date(latest).toISOString()
}
