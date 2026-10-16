import {
  AGENT_MEMORY_LANE,
  AGENT_MEMORY_OPERATION_MODE,
  AGENT_MEMORY_SCOPE,
  AGENT_MEMORY_SENSITIVITY,
  AgentMemoryLaneSchema,
  AgentMemoryOperationModeSchema,
  AgentMemoryScopeSchema,
  AgentMemorySensitivitySchema,
} from '@haohaoxue/lexora-contracts'
import { z } from 'zod'

const NullableStringSchema = z.string().trim().min(1).nullable().default(null)
export const RelatedMemoryIdsSchema = z.array(z.string().trim().min(1)).default([])

export const MemoryWriteBaseSchema = z.object({
  mode: AgentMemoryOperationModeSchema.default(AGENT_MEMORY_OPERATION_MODE.BACKGROUND_SUGGESTION),
  scope: AgentMemoryScopeSchema.default(AGENT_MEMORY_SCOPE.USER),
  lane: AgentMemoryLaneSchema,
  slotKey: NullableStringSchema,
  slotValue: NullableStringSchema,
  content: z.string().trim().min(1),
  summary: NullableStringSchema,
  relatedMemoryIds: RelatedMemoryIdsSchema,
  confidence: z.number().min(0).max(1).default(0.86),
  sensitivity: AgentMemorySensitivitySchema.default(AGENT_MEMORY_SENSITIVITY.NORMAL),
  reason: NullableStringSchema,
}).strict()

export const MemoryUpdateSchema = MemoryWriteBaseSchema.refine(
  value => Boolean(value.slotKey) || value.relatedMemoryIds.length > 0,
  'memory_update requires slotKey or relatedMemoryIds.',
)

export const MemoryForgetSchema = z.object({
  mode: AgentMemoryOperationModeSchema.default(AGENT_MEMORY_OPERATION_MODE.DIRECT),
  scope: AgentMemoryScopeSchema.default(AGENT_MEMORY_SCOPE.USER),
  lane: AgentMemoryLaneSchema.default(AGENT_MEMORY_LANE.USER_PREFERENCE),
  query: z.string().trim().min(1),
  relatedMemoryIds: RelatedMemoryIdsSchema,
  confidence: z.number().min(0).max(1).default(0.9),
  sensitivity: AgentMemorySensitivitySchema.default(AGENT_MEMORY_SENSITIVITY.NORMAL),
  reason: NullableStringSchema,
}).strict()

export const MemoryIgnoreSchema = z.object({
  mode: AgentMemoryOperationModeSchema.default(AGENT_MEMORY_OPERATION_MODE.IGNORED),
  scope: AgentMemoryScopeSchema.default(AGENT_MEMORY_SCOPE.USER),
  lane: AgentMemoryLaneSchema.default(AGENT_MEMORY_LANE.TASK_KNOWLEDGE),
  query: NullableStringSchema,
  confidence: z.number().min(0).max(1).default(0.8),
  sensitivity: AgentMemorySensitivitySchema.default(AGENT_MEMORY_SENSITIVITY.NORMAL),
  reason: z.string().trim().min(1),
}).strict()

export const MemoryAskUserSchema = z.object({
  mode: AgentMemoryOperationModeSchema.default(AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION),
  scope: AgentMemoryScopeSchema.default(AGENT_MEMORY_SCOPE.USER),
  lane: AgentMemoryLaneSchema.default(AGENT_MEMORY_LANE.TASK_KNOWLEDGE),
  query: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  sensitivity: AgentMemorySensitivitySchema.default(AGENT_MEMORY_SENSITIVITY.NORMAL),
  reason: z.string().trim().min(1),
}).strict()
