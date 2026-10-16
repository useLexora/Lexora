import { z } from 'zod'
import { AgentMemoryRetrievalSnapshotSchema } from './memory'
import { ChatGenerationModelTargetSnapshotSchema } from './model'
import { AgentProfileSnapshotSchema } from './profile'

const NonEmptyStringSchema = z.string().trim().min(1)
const TokenCountSchema = z.number().int().nonnegative()

export const ChatMessageGenerationStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export const ChatGenerationContextBudgetSnapshotSchema = z.object({
  contextWindow: TokenCountSchema,
  reservedOutputTokens: TokenCountSchema,
  systemPromptTokens: TokenCountSchema,
  contextSnapshotTokens: TokenCountSchema,
  memoryPromptTokens: TokenCountSchema.default(0),
  historyDigestTokens: TokenCountSchema,
  recentMessageTokens: TokenCountSchema,
  safetyBufferTokens: TokenCountSchema,
  availableInputTokens: TokenCountSchema,
  recentMessageBudgetTokens: TokenCountSchema.default(0),
  budgetUsedRatio: z.number().nonnegative(),
  compactionThreshold: z.number().min(0).max(1),
  overflowTokens: TokenCountSchema,
  estimationSource: z.enum(['provider-tokenizer', 'tiktoken-compatible', 'heuristic']),
  safetyMultiplier: z.number().positive(),
}).strict()

export const ChatGenerationUsageSnapshotSchema = z.object({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  reasoningTokens: TokenCountSchema.default(0),
  totalTokens: TokenCountSchema,
  usageSource: z.enum(['provider', 'estimated', 'mixed']),
  estimated: z.boolean(),
  firstTokenLatencyMs: z.number().int().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  contextBudget: ChatGenerationContextBudgetSnapshotSchema.optional(),
  memoryRetrieval: AgentMemoryRetrievalSnapshotSchema.optional(),
}).strict()

export const ChatMessageGenerationSnapshotSchema = z.object({
  generationId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  assistantMessageId: NonEmptyStringSchema,
  triggerUserMessageId: NonEmptyStringSchema,
  actorUserId: NonEmptyStringSchema,
  agentProfileSnapshot: AgentProfileSnapshotSchema,
  modelTargetSnapshot: ChatGenerationModelTargetSnapshotSchema,
  usageSnapshot: ChatGenerationUsageSnapshotSchema.nullable().optional(),
}).strict()

export type ChatMessageGenerationStatus = z.infer<typeof ChatMessageGenerationStatusSchema>
export type ChatGenerationContextBudgetSnapshot = z.infer<typeof ChatGenerationContextBudgetSnapshotSchema>
export type ChatGenerationUsageSnapshot = z.infer<typeof ChatGenerationUsageSnapshotSchema>
export type ChatMessageGenerationSnapshot = z.infer<typeof ChatMessageGenerationSnapshotSchema>
