import type {
  AgentMemory,
  AgentMemoryLane,
  AgentMemoryScope,
  AgentMemorySensitivity,
  AgentMemorySourceType,
  AgentMemoryStatus,
} from '@haohaoxue/lexora-contracts'
import type {
  AgentMemory as PrismaAgentMemory,
  AgentMemoryLane as PrismaAgentMemoryLane,
  AgentMemoryScope as PrismaAgentMemoryScope,
  AgentMemorySensitivity as PrismaAgentMemorySensitivity,
  AgentMemorySourceType as PrismaAgentMemorySourceType,
  AgentMemoryStatus as PrismaAgentMemoryStatus,
} from '@prisma/client'
import {
  AGENT_MEMORY_LANE,
  AGENT_MEMORY_SCOPE,
  AGENT_MEMORY_SENSITIVITY,
  AGENT_MEMORY_SOURCE_TYPE,
  AGENT_MEMORY_STATUS,
} from '@haohaoxue/lexora-contracts'

export function toPrismaMemoryScope(scope: AgentMemoryScope): PrismaAgentMemoryScope {
  return scope === AGENT_MEMORY_SCOPE.USER_AGENT ? 'USER_AGENT' : 'USER'
}

export function toDomainMemoryScope(scope: PrismaAgentMemoryScope): AgentMemoryScope {
  return scope === 'USER_AGENT' ? AGENT_MEMORY_SCOPE.USER_AGENT : AGENT_MEMORY_SCOPE.USER
}

export function toPrismaMemoryLane(lane: AgentMemoryLane): PrismaAgentMemoryLane {
  switch (lane) {
    case AGENT_MEMORY_LANE.USER_PROFILE:
      return 'USER_PROFILE'
    case AGENT_MEMORY_LANE.USER_PREFERENCE:
      return 'USER_PREFERENCE'
    case AGENT_MEMORY_LANE.USER_FEEDBACK:
      return 'USER_FEEDBACK'
    case AGENT_MEMORY_LANE.AGENT_PERSONALIZATION:
      return 'AGENT_PERSONALIZATION'
    case AGENT_MEMORY_LANE.PROJECT_REFERENCE:
      return 'PROJECT_REFERENCE'
    case AGENT_MEMORY_LANE.TASK_KNOWLEDGE:
      return 'TASK_KNOWLEDGE'
  }
}

export function toDomainMemoryLane(lane: PrismaAgentMemoryLane): AgentMemoryLane {
  switch (lane) {
    case 'USER_PROFILE':
      return AGENT_MEMORY_LANE.USER_PROFILE
    case 'USER_PREFERENCE':
      return AGENT_MEMORY_LANE.USER_PREFERENCE
    case 'USER_FEEDBACK':
      return AGENT_MEMORY_LANE.USER_FEEDBACK
    case 'AGENT_PERSONALIZATION':
      return AGENT_MEMORY_LANE.AGENT_PERSONALIZATION
    case 'PROJECT_REFERENCE':
      return AGENT_MEMORY_LANE.PROJECT_REFERENCE
    case 'TASK_KNOWLEDGE':
      return AGENT_MEMORY_LANE.TASK_KNOWLEDGE
  }
}

export function toPrismaMemoryStatus(status: AgentMemoryStatus): PrismaAgentMemoryStatus {
  switch (status) {
    case AGENT_MEMORY_STATUS.ACTIVE:
      return 'ACTIVE'
    case AGENT_MEMORY_STATUS.DISABLED:
      return 'DISABLED'
    case AGENT_MEMORY_STATUS.ARCHIVED:
      return 'ARCHIVED'
  }
}

export function toDomainMemoryStatus(status: PrismaAgentMemoryStatus): AgentMemoryStatus {
  switch (status) {
    case 'ACTIVE':
      return AGENT_MEMORY_STATUS.ACTIVE
    case 'DISABLED':
      return AGENT_MEMORY_STATUS.DISABLED
    case 'ARCHIVED':
      return AGENT_MEMORY_STATUS.ARCHIVED
  }
}

export function toPrismaMemorySensitivity(sensitivity: AgentMemorySensitivity): PrismaAgentMemorySensitivity {
  return sensitivity === AGENT_MEMORY_SENSITIVITY.SENSITIVE ? 'SENSITIVE' : 'NORMAL'
}

export function toDomainMemorySensitivity(sensitivity: PrismaAgentMemorySensitivity): AgentMemorySensitivity {
  return sensitivity === 'SENSITIVE' ? AGENT_MEMORY_SENSITIVITY.SENSITIVE : AGENT_MEMORY_SENSITIVITY.NORMAL
}

export function toPrismaMemorySourceType(sourceType: AgentMemorySourceType): PrismaAgentMemorySourceType {
  switch (sourceType) {
    case AGENT_MEMORY_SOURCE_TYPE.USER_FEEDBACK:
      return 'USER_FEEDBACK'
    case AGENT_MEMORY_SOURCE_TYPE.IMPORTED:
      return 'IMPORTED'
    case AGENT_MEMORY_SOURCE_TYPE.MANUAL:
      return 'MANUAL'
  }
}

export function toDomainMemorySourceType(sourceType: PrismaAgentMemorySourceType): AgentMemorySourceType {
  switch (sourceType) {
    case 'USER_FEEDBACK':
      return AGENT_MEMORY_SOURCE_TYPE.USER_FEEDBACK
    case 'IMPORTED':
      return AGENT_MEMORY_SOURCE_TYPE.IMPORTED
    case 'MANUAL':
      return AGENT_MEMORY_SOURCE_TYPE.MANUAL
  }
}

export function toAgentMemory(memory: PrismaAgentMemory): AgentMemory {
  return {
    id: memory.id,
    scope: toDomainMemoryScope(memory.scope),
    lane: toDomainMemoryLane(memory.lane),
    ownerUserId: memory.ownerUserId,
    workspaceId: memory.workspaceId,
    agentProfileId: memory.agentProfileId,
    slotKey: memory.slotKey,
    slotValue: memory.slotValue,
    content: memory.content,
    summary: memory.summary,
    sensitivity: toDomainMemorySensitivity(memory.sensitivity),
    confidence: memory.confidence,
    sourceType: toDomainMemorySourceType(memory.sourceType),
    sourceSessionId: memory.sourceSessionId,
    sourceMessageId: memory.sourceMessageId,
    sourceGenerationId: memory.sourceGenerationId,
    status: toDomainMemoryStatus(memory.status),
    supersedesMemoryId: memory.supersedesMemoryId,
    createdByUserId: memory.createdByUserId,
    acceptedByUserId: memory.acceptedByUserId,
    lastUsedAt: memory.lastUsedAt?.toISOString() ?? null,
    expiresAt: memory.expiresAt?.toISOString() ?? null,
    deletedAt: memory.deletedAt?.toISOString() ?? null,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  }
}

export function getAgentMemoryLaneTitle(lane: AgentMemoryLane): string {
  switch (lane) {
    case AGENT_MEMORY_LANE.USER_PROFILE:
      return '用户画像'
    case AGENT_MEMORY_LANE.USER_PREFERENCE:
      return '用户偏好'
    case AGENT_MEMORY_LANE.USER_FEEDBACK:
      return '用户反馈'
    case AGENT_MEMORY_LANE.AGENT_PERSONALIZATION:
      return '助手个性化'
    case AGENT_MEMORY_LANE.PROJECT_REFERENCE:
      return '项目参考'
    case AGENT_MEMORY_LANE.TASK_KNOWLEDGE:
      return '任务知识'
  }
}

export function normalizeAgentMemorySlotKey(slotKey: string | null | undefined): string | null {
  const normalized = slotKey?.trim().toLowerCase() ?? ''
  return normalized || null
}

export function buildAgentMemorySearchText(memory: Pick<PrismaAgentMemory, 'slotKey' | 'slotValue' | 'summary' | 'content'>): string {
  return [
    memory.slotKey,
    memory.slotValue,
    memory.summary,
    memory.content,
  ].map(item => item?.trim()).filter(Boolean).join('\n')
}

export function estimateAgentMemoryTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) {
    return 0
  }

  const cjkCount = Array.from(trimmed.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)).length
  const nonCjkLength = trimmed.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, '').length

  return Math.max(1, Math.ceil(cjkCount + nonCjkLength / 3.5))
}

export function isUnsafeAgentMemoryPayload(memory: {
  slotValue?: string | null
  summary?: string | null
  content: string
}): boolean {
  const text = `${memory.slotValue ?? ''}\n${memory.summary ?? ''}\n${memory.content}`.toLowerCase()

  return isUnsafeAgentMemoryText(text)
}

export function isUnsafeAgentMemoryText(text: string): boolean {
  return /sk-[a-z0-9]{16,}/i.test(text)
    || /(?:^|\W)(?:api[_-]?key|password|token|cookie|secret)\s*[:=]/i.test(text)
    || text.includes('忽略以上')
    || text.includes('ignore previous')
    || /[\u202A-\u202E\u2066-\u2069]/u.test(text)
}
