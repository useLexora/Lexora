import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)
const IsoDateTimeStringSchema = z.string().datetime()
const TokenCountSchema = z.number().int().nonnegative()

export const AGENT_MEMORY_SCOPE = {
  USER: 'user',
  USER_AGENT: 'user_agent',
} as const

export const AGENT_MEMORY_SCOPE_VALUES = [
  AGENT_MEMORY_SCOPE.USER,
  AGENT_MEMORY_SCOPE.USER_AGENT,
] as const

export const AGENT_MEMORY_LANE = {
  USER_PROFILE: 'user_profile',
  USER_PREFERENCE: 'user_preference',
  USER_FEEDBACK: 'user_feedback',
  AGENT_PERSONALIZATION: 'agent_personalization',
  PROJECT_REFERENCE: 'project_reference',
  TASK_KNOWLEDGE: 'task_knowledge',
} as const

export const AGENT_MEMORY_LANE_VALUES = [
  AGENT_MEMORY_LANE.USER_PROFILE,
  AGENT_MEMORY_LANE.USER_PREFERENCE,
  AGENT_MEMORY_LANE.USER_FEEDBACK,
  AGENT_MEMORY_LANE.AGENT_PERSONALIZATION,
  AGENT_MEMORY_LANE.PROJECT_REFERENCE,
  AGENT_MEMORY_LANE.TASK_KNOWLEDGE,
] as const

export const AGENT_MEMORY_STATUS = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
  ARCHIVED: 'archived',
} as const

export const AGENT_MEMORY_STATUS_VALUES = [
  AGENT_MEMORY_STATUS.ACTIVE,
  AGENT_MEMORY_STATUS.DISABLED,
  AGENT_MEMORY_STATUS.ARCHIVED,
] as const

export const AGENT_MEMORY_SENSITIVITY = {
  NORMAL: 'normal',
  SENSITIVE: 'sensitive',
} as const

export const AGENT_MEMORY_SENSITIVITY_VALUES = [
  AGENT_MEMORY_SENSITIVITY.NORMAL,
  AGENT_MEMORY_SENSITIVITY.SENSITIVE,
] as const

export const AGENT_MEMORY_SOURCE_TYPE = {
  MANUAL: 'manual',
  USER_FEEDBACK: 'user_feedback',
  IMPORTED: 'imported',
} as const

export const AGENT_MEMORY_SOURCE_TYPE_VALUES = [
  AGENT_MEMORY_SOURCE_TYPE.MANUAL,
  AGENT_MEMORY_SOURCE_TYPE.USER_FEEDBACK,
  AGENT_MEMORY_SOURCE_TYPE.IMPORTED,
] as const

export const AGENT_MEMORY_OPERATION_MODE = {
  DIRECT: 'direct',
  PENDING_CONFIRMATION: 'pending_confirmation',
  BACKGROUND_SUGGESTION: 'background_suggestion',
  IGNORED: 'ignored',
} as const

export const AGENT_MEMORY_OPERATION_MODE_VALUES = [
  AGENT_MEMORY_OPERATION_MODE.DIRECT,
  AGENT_MEMORY_OPERATION_MODE.PENDING_CONFIRMATION,
  AGENT_MEMORY_OPERATION_MODE.BACKGROUND_SUGGESTION,
  AGENT_MEMORY_OPERATION_MODE.IGNORED,
] as const

export const AGENT_MEMORY_OPERATION_ACTION = {
  CREATE: 'create',
  APPEND: 'append',
  UPDATE: 'update',
  DISABLE: 'disable',
  FORGET: 'forget',
  IGNORE: 'ignore',
  ASK_USER: 'ask_user',
} as const

export const AGENT_MEMORY_OPERATION_ACTION_VALUES = [
  AGENT_MEMORY_OPERATION_ACTION.CREATE,
  AGENT_MEMORY_OPERATION_ACTION.APPEND,
  AGENT_MEMORY_OPERATION_ACTION.UPDATE,
  AGENT_MEMORY_OPERATION_ACTION.DISABLE,
  AGENT_MEMORY_OPERATION_ACTION.FORGET,
  AGENT_MEMORY_OPERATION_ACTION.IGNORE,
  AGENT_MEMORY_OPERATION_ACTION.ASK_USER,
] as const

export const AGENT_MEMORY_SLOT_KEY = {
  AGENT_NAME: 'agent.name',
} as const

export const AGENT_MEMORY_CANDIDATE_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  DISMISSED: 'dismissed',
} as const

export const AGENT_MEMORY_CANDIDATE_STATUS_VALUES = [
  AGENT_MEMORY_CANDIDATE_STATUS.PENDING,
  AGENT_MEMORY_CANDIDATE_STATUS.ACCEPTED,
  AGENT_MEMORY_CANDIDATE_STATUS.REJECTED,
  AGENT_MEMORY_CANDIDATE_STATUS.DISMISSED,
] as const

export const AGENT_MEMORY_CANDIDATE_KIND = {
  PROFILE: 'profile',
  PREFERENCE: 'preference',
  FEEDBACK: 'feedback',
  PROJECT_REFERENCE: 'project_reference',
  TASK_KNOWLEDGE: 'task_knowledge',
  FORGET_REQUEST: 'forget_request',
} as const

export const AGENT_MEMORY_CANDIDATE_KIND_VALUES = [
  AGENT_MEMORY_CANDIDATE_KIND.PROFILE,
  AGENT_MEMORY_CANDIDATE_KIND.PREFERENCE,
  AGENT_MEMORY_CANDIDATE_KIND.FEEDBACK,
  AGENT_MEMORY_CANDIDATE_KIND.PROJECT_REFERENCE,
  AGENT_MEMORY_CANDIDATE_KIND.TASK_KNOWLEDGE,
  AGENT_MEMORY_CANDIDATE_KIND.FORGET_REQUEST,
] as const

export const AGENT_MEMORY_OPERATION_DISPLAY_CODE = {
  REMEMBERED: 'memory.remembered',
  UPDATED: 'memory.updated',
  FORGOTTEN: 'memory.forgotten',
  IGNORED: 'memory.ignored',
  PENDING: 'memory.pending',
  EXISTS: 'memory.exists',
  FAILED: 'memory.failed',
} as const

export const AGENT_MEMORY_OPERATION_DISPLAY_CODE_VALUES = [
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.REMEMBERED,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.UPDATED,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.FORGOTTEN,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.IGNORED,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.PENDING,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.EXISTS,
  AGENT_MEMORY_OPERATION_DISPLAY_CODE.FAILED,
] as const

export const AGENT_MEMORY_OPERATION_REASON_CODE = {
  SENSITIVE_CONTENT: 'memory.reason.sensitive-content',
  WRITING_DISABLED: 'memory.reason.writing-disabled',
  BROAD_FORGET: 'memory.reason.broad-forget',
  DUPLICATE: 'memory.reason.duplicate',
  FAILED: 'memory.reason.failed',
} as const

export const AGENT_MEMORY_OPERATION_REASON_CODE_VALUES = [
  AGENT_MEMORY_OPERATION_REASON_CODE.SENSITIVE_CONTENT,
  AGENT_MEMORY_OPERATION_REASON_CODE.WRITING_DISABLED,
  AGENT_MEMORY_OPERATION_REASON_CODE.BROAD_FORGET,
  AGENT_MEMORY_OPERATION_REASON_CODE.DUPLICATE,
  AGENT_MEMORY_OPERATION_REASON_CODE.FAILED,
] as const

export const AGENT_MEMORY_DOCUMENT_ID = {
  SOUL: 'soul',
  USER: 'user',
  MEMORY: 'memory',
} as const

export const AGENT_MEMORY_DOCUMENT_ID_VALUES = [
  AGENT_MEMORY_DOCUMENT_ID.SOUL,
  AGENT_MEMORY_DOCUMENT_ID.USER,
  AGENT_MEMORY_DOCUMENT_ID.MEMORY,
] as const

export const AGENT_MEMORY_SKILL_KEY = 'lexora.memory' as const

export const AGENT_MEMORY_TOOL = {
  REMEMBER: 'memory_remember',
  UPDATE: 'memory_update',
  FORGET: 'memory_forget',
  IGNORE: 'memory_ignore',
  ASK_USER: 'memory_ask_user',
} as const

export const AGENT_MEMORY_TOOL_VALUES = [
  AGENT_MEMORY_TOOL.REMEMBER,
  AGENT_MEMORY_TOOL.UPDATE,
  AGENT_MEMORY_TOOL.FORGET,
  AGENT_MEMORY_TOOL.IGNORE,
  AGENT_MEMORY_TOOL.ASK_USER,
] as const

export const AgentMemoryScopeSchema = z.enum(AGENT_MEMORY_SCOPE_VALUES)
export const AgentMemoryLaneSchema = z.enum(AGENT_MEMORY_LANE_VALUES)
export const AgentMemoryStatusSchema = z.enum(AGENT_MEMORY_STATUS_VALUES)
export const AgentMemorySensitivitySchema = z.enum(AGENT_MEMORY_SENSITIVITY_VALUES)
export const AgentMemorySourceTypeSchema = z.enum(AGENT_MEMORY_SOURCE_TYPE_VALUES)
export const AgentMemoryOperationModeSchema = z.enum(AGENT_MEMORY_OPERATION_MODE_VALUES)
export const AgentMemoryOperationActionSchema = z.enum(AGENT_MEMORY_OPERATION_ACTION_VALUES)
export const AgentMemoryCandidateStatusSchema = z.enum(AGENT_MEMORY_CANDIDATE_STATUS_VALUES)
export const AgentMemoryCandidateKindSchema = z.enum(AGENT_MEMORY_CANDIDATE_KIND_VALUES)
export const AgentMemoryOperationDisplayCodeSchema = z.enum(AGENT_MEMORY_OPERATION_DISPLAY_CODE_VALUES)
export const AgentMemoryOperationReasonCodeSchema = z.enum(AGENT_MEMORY_OPERATION_REASON_CODE_VALUES)
export const AgentMemoryDocumentIdSchema = z.enum(AGENT_MEMORY_DOCUMENT_ID_VALUES)
export const AgentMemoryToolNameSchema = z.enum(AGENT_MEMORY_TOOL_VALUES)

const AgentMemoryLaneCountMapSchema = z.object({
  [AGENT_MEMORY_LANE.USER_PROFILE]: z.number().int().nonnegative().optional(),
  [AGENT_MEMORY_LANE.USER_PREFERENCE]: z.number().int().nonnegative().optional(),
  [AGENT_MEMORY_LANE.USER_FEEDBACK]: z.number().int().nonnegative().optional(),
  [AGENT_MEMORY_LANE.AGENT_PERSONALIZATION]: z.number().int().nonnegative().optional(),
  [AGENT_MEMORY_LANE.PROJECT_REFERENCE]: z.number().int().nonnegative().optional(),
  [AGENT_MEMORY_LANE.TASK_KNOWLEDGE]: z.number().int().nonnegative().optional(),
}).strict()

export const AgentMemoryWritingPolicySchema = z.object({
  enabled: z.boolean().default(true),
  minAutoApplyConfidence: z.number().min(0).max(1).default(0.8),
  requireConfirmationForSensitive: z.boolean().default(true),
}).strict().default({
  enabled: true,
  minAutoApplyConfidence: 0.8,
  requireConfirmationForSensitive: true,
})

export const AgentMemoryPolicySchema = z.object({
  enabled: z.boolean().default(true),
  ignoredForRun: z.boolean().default(false),
  scopes: z.array(AgentMemoryScopeSchema).default([...AGENT_MEMORY_SCOPE_VALUES]),
  lanes: z.array(AgentMemoryLaneSchema).default([...AGENT_MEMORY_LANE_VALUES]),
  perLaneTopK: AgentMemoryLaneCountMapSchema.default({}),
  perLaneBudget: AgentMemoryLaneCountMapSchema.default({}),
  maxInjectedTokens: z.number().int().positive().default(1200),
  includeSensitive: z.boolean().default(false),
  writing: AgentMemoryWritingPolicySchema,
}).strict().default({
  enabled: true,
  ignoredForRun: false,
  scopes: [...AGENT_MEMORY_SCOPE_VALUES],
  lanes: [...AGENT_MEMORY_LANE_VALUES],
  perLaneTopK: {},
  perLaneBudget: {},
  maxInjectedTokens: 1200,
  includeSensitive: false,
  writing: {
    enabled: true,
    minAutoApplyConfidence: 0.8,
    requireConfirmationForSensitive: true,
  },
})

export const AgentMemorySchema = z.object({
  id: NonEmptyStringSchema,
  scope: AgentMemoryScopeSchema,
  lane: AgentMemoryLaneSchema,
  ownerUserId: NonEmptyStringSchema,
  workspaceId: NonEmptyStringSchema.nullable(),
  agentProfileId: NonEmptyStringSchema.nullable(),
  slotKey: z.string().trim().min(1).nullable(),
  slotValue: z.string().trim().min(1).nullable(),
  content: NonEmptyStringSchema,
  summary: z.string().trim().min(1).nullable(),
  sensitivity: AgentMemorySensitivitySchema,
  confidence: z.number().min(0).max(1),
  sourceType: AgentMemorySourceTypeSchema,
  sourceSessionId: NonEmptyStringSchema.nullable(),
  sourceMessageId: NonEmptyStringSchema.nullable(),
  sourceGenerationId: NonEmptyStringSchema.nullable(),
  status: AgentMemoryStatusSchema,
  supersedesMemoryId: NonEmptyStringSchema.nullable(),
  createdByUserId: NonEmptyStringSchema,
  acceptedByUserId: NonEmptyStringSchema.nullable(),
  lastUsedAt: IsoDateTimeStringSchema.nullable(),
  expiresAt: IsoDateTimeStringSchema.nullable(),
  deletedAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const AgentMemoryOperationSourceSchema = z.object({
  sessionId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema,
  generationId: NonEmptyStringSchema.nullable(),
  userId: NonEmptyStringSchema,
}).strict()

export const AgentMemoryOperationSchema = z.object({
  operationId: NonEmptyStringSchema,
  source: AgentMemoryOperationSourceSchema,
  action: AgentMemoryOperationActionSchema,
  mode: AgentMemoryOperationModeSchema,
  scope: AgentMemoryScopeSchema,
  lane: AgentMemoryLaneSchema,
  slotKey: z.string().trim().min(1).nullable(),
  slotValue: z.string().trim().min(1).nullable(),
  content: z.string().trim().min(1).nullable(),
  summary: z.string().trim().min(1).nullable(),
  query: z.string().trim().min(1).nullable(),
  relatedMemoryIds: z.array(NonEmptyStringSchema),
  confidence: z.number().min(0).max(1),
  sensitivity: AgentMemorySensitivitySchema,
  reason: z.string().trim().min(1).nullable(),
  createdAt: IsoDateTimeStringSchema,
}).strict()

export const AgentMemoryOperationProposalSchema = AgentMemoryOperationSchema.omit({
  operationId: true,
  source: true,
  createdAt: true,
}).extend({
  relatedMemoryIds: z.array(NonEmptyStringSchema).default([]),
}).strict()

export const AgentMemoryToolManifestSchema = z.object({
  name: AgentMemoryToolNameSchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  actions: z.array(AgentMemoryOperationActionSchema).min(1),
}).strict()

export const AgentMemorySkillManifestSchema = z.object({
  key: z.literal(AGENT_MEMORY_SKILL_KEY),
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  tools: z.array(AgentMemoryToolManifestSchema).min(1),
}).strict()

export const AGENT_MEMORY_SKILL_MANIFEST = AgentMemorySkillManifestSchema.parse({
  key: AGENT_MEMORY_SKILL_KEY,
  title: 'Memory',
  description: '让 Agent 在对话中基于用户意图和长期价值判断读写、更新、忘记或忽略记忆。',
  tools: [
    {
      name: AGENT_MEMORY_TOOL.REMEMBER,
      title: '记住信息',
      description: '保存长期稳定、低风险且对未来对话有价值的信息。',
      actions: [AGENT_MEMORY_OPERATION_ACTION.CREATE, AGENT_MEMORY_OPERATION_ACTION.APPEND],
    },
    {
      name: AGENT_MEMORY_TOOL.UPDATE,
      title: '更新记忆',
      description: '在已知相关记忆的基础上修正、覆盖或关闭过期事实。',
      actions: [AGENT_MEMORY_OPERATION_ACTION.UPDATE, AGENT_MEMORY_OPERATION_ACTION.DISABLE],
    },
    {
      name: AGENT_MEMORY_TOOL.FORGET,
      title: '忘记记忆',
      description: '根据用户要求或明确失效信号归档相关记忆。',
      actions: [AGENT_MEMORY_OPERATION_ACTION.FORGET],
    },
  ],
})

export const AgentMemoryOperationResultSchema = z.object({
  operationId: NonEmptyStringSchema,
  status: z.enum(['applied', 'pending_confirmation', 'ignored', 'failed']),
  memoryIds: z.array(NonEmptyStringSchema),
  archivedMemoryIds: z.array(NonEmptyStringSchema),
  candidateId: NonEmptyStringSchema.nullable(),
  message: NonEmptyStringSchema,
  reason: z.string().trim().min(1).nullable(),
}).strict()

export const AgentMemoryCandidateSchema = z.object({
  id: NonEmptyStringSchema,
  ownerUserId: NonEmptyStringSchema,
  agentProfileId: NonEmptyStringSchema.nullable(),
  sessionId: NonEmptyStringSchema,
  sourceMessageId: NonEmptyStringSchema,
  sourceGenerationId: NonEmptyStringSchema.nullable(),
  kind: AgentMemoryCandidateKindSchema,
  action: AgentMemoryOperationActionSchema,
  mode: AgentMemoryOperationModeSchema,
  status: AgentMemoryCandidateStatusSchema,
  scope: AgentMemoryScopeSchema,
  lane: AgentMemoryLaneSchema,
  slotKey: z.string().trim().min(1).nullable(),
  slotValue: z.string().trim().min(1).nullable(),
  content: NonEmptyStringSchema,
  summary: z.string().trim().min(1).nullable(),
  reason: z.string().trim().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  sensitivity: AgentMemorySensitivitySchema,
  relatedMemoryIds: z.array(NonEmptyStringSchema),
  resultMemoryIds: z.array(NonEmptyStringSchema),
  operation: AgentMemoryOperationSchema,
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
  acceptedAt: IsoDateTimeStringSchema.nullable(),
  rejectedAt: IsoDateTimeStringSchema.nullable(),
  dismissedAt: IsoDateTimeStringSchema.nullable(),
}).strict()

export const ChatMemoryOperationProjectionSchema = z.object({
  operationId: NonEmptyStringSchema,
  action: AgentMemoryOperationActionSchema,
  mode: AgentMemoryOperationModeSchema,
  status: z.enum(['applied', 'pending_confirmation', 'ignored', 'failed']),
  scope: AgentMemoryScopeSchema,
  lane: AgentMemoryLaneSchema,
  memoryIds: z.array(NonEmptyStringSchema),
  archivedMemoryIds: z.array(NonEmptyStringSchema).default([]),
  candidateId: NonEmptyStringSchema.nullable(),
  displayCode: AgentMemoryOperationDisplayCodeSchema,
  reasonCode: AgentMemoryOperationReasonCodeSchema.nullable(),
  title: NonEmptyStringSchema,
  detail: z.string().trim().min(1).nullable(),
  reason: z.string().trim().min(1).nullable(),
  createdAt: IsoDateTimeStringSchema,
}).strict()

export const AgentMemoryPromptItemSchema = z.object({
  memoryId: NonEmptyStringSchema,
  content: NonEmptyStringSchema,
  score: z.number().nonnegative().nullable().optional(),
  slotKey: z.string().trim().min(1).nullable().optional(),
}).strict()

export const AgentMemoryRenderedSectionSchema = z.object({
  lane: AgentMemoryLaneSchema,
  title: NonEmptyStringSchema,
  items: z.array(AgentMemoryPromptItemSchema),
}).strict()

export const AgentMemoryRetrievalSnapshotSchema = z.object({
  enabled: z.boolean(),
  ignoredForRun: z.boolean(),
  query: z.string(),
  scopes: z.array(AgentMemoryScopeSchema),
  lanes: z.array(AgentMemoryLaneSchema),
  selectedMemoryIds: z.array(NonEmptyStringSchema),
  omittedMemoryIds: z.array(NonEmptyStringSchema),
  injectedCount: z.number().int().nonnegative(),
  estimatedTokens: TokenCountSchema,
  budgetTokens: TokenCountSchema,
  retriever: z.enum(['disabled', 'none', 'pinned', 'text', 'pinned+text']),
  renderedSections: z.array(AgentMemoryRenderedSectionSchema),
  createdAt: IsoDateTimeStringSchema,
}).strict()

export const AgentMemoryRunOptionsSchema = z.object({
  ignoredForRun: z.boolean().default(false),
}).strict().default({
  ignoredForRun: false,
})

export const ListAgentMemoryDocumentsQuerySchema = z.object({
  agentProfileId: NonEmptyStringSchema.optional(),
}).strict()

export const AgentMemoryDocumentSchema = z.object({
  id: AgentMemoryDocumentIdSchema,
  name: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  content: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: IsoDateTimeStringSchema.nullable(),
  sourceMemoryIds: z.array(NonEmptyStringSchema),
}).strict()

export const AgentMemoryDocumentsResponseSchema = z.object({
  documents: z.array(AgentMemoryDocumentSchema),
}).strict()

export const GetAgentMemoryDocumentParamsSchema = z.object({
  documentId: AgentMemoryDocumentIdSchema,
}).strict()

export const RetrieveAgentMemoryRequestSchema = z.object({
  actorUserId: NonEmptyStringSchema,
  agentProfileId: NonEmptyStringSchema.nullable(),
  generationId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  query: z.string(),
  policy: AgentMemoryPolicySchema,
}).strict()

export const RetrieveAgentMemoryResponseSchema = z.object({
  snapshot: AgentMemoryRetrievalSnapshotSchema,
}).strict()

export const ExecuteAgentMemoryOperationProposalsRequestSchema = z.object({
  actorUserId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema,
  generationId: NonEmptyStringSchema,
  agentProfileId: NonEmptyStringSchema.nullable(),
  memoryWritingPolicy: AgentMemoryWritingPolicySchema.optional(),
  operations: z.array(AgentMemoryOperationProposalSchema),
}).strict()

export const ExecuteAgentMemoryOperationProposalsResponseSchema = z.object({
  operations: z.array(ChatMemoryOperationProjectionSchema),
}).strict()

export const AgentMemoryExtractorInputSchema = z.object({
  source: AgentMemoryOperationSourceSchema,
  userMessage: NonEmptyStringSchema,
  assistantReply: z.string().trim().min(1).nullable(),
  retrievalSnapshot: AgentMemoryRetrievalSnapshotSchema.nullable(),
  relatedMemories: z.array(AgentMemorySchema),
}).strict()

export const AgentMemoryExtractorOutputSchema = z.object({
  operations: z.array(AgentMemoryOperationSchema),
}).strict()

export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>
export type AgentMemoryLane = z.infer<typeof AgentMemoryLaneSchema>
export type AgentMemoryStatus = z.infer<typeof AgentMemoryStatusSchema>
export type AgentMemorySensitivity = z.infer<typeof AgentMemorySensitivitySchema>
export type AgentMemorySourceType = z.infer<typeof AgentMemorySourceTypeSchema>
export type AgentMemoryOperationMode = z.infer<typeof AgentMemoryOperationModeSchema>
export type AgentMemoryOperationAction = z.infer<typeof AgentMemoryOperationActionSchema>
export type AgentMemoryCandidateStatus = z.infer<typeof AgentMemoryCandidateStatusSchema>
export type AgentMemoryCandidateKind = z.infer<typeof AgentMemoryCandidateKindSchema>
export type AgentMemoryOperationDisplayCode = z.infer<typeof AgentMemoryOperationDisplayCodeSchema>
export type AgentMemoryOperationReasonCode = z.infer<typeof AgentMemoryOperationReasonCodeSchema>
export type AgentMemoryDocumentId = z.infer<typeof AgentMemoryDocumentIdSchema>
export type AgentMemoryWritingPolicy = z.infer<typeof AgentMemoryWritingPolicySchema>
export type AgentMemoryPolicy = z.infer<typeof AgentMemoryPolicySchema>
export type AgentMemory = z.infer<typeof AgentMemorySchema>
export type AgentMemoryOperationSource = z.infer<typeof AgentMemoryOperationSourceSchema>
export type AgentMemoryOperation = z.infer<typeof AgentMemoryOperationSchema>
export type AgentMemoryOperationProposal = z.infer<typeof AgentMemoryOperationProposalSchema>
export type AgentMemoryOperationResult = z.infer<typeof AgentMemoryOperationResultSchema>
export type AgentMemoryCandidate = z.infer<typeof AgentMemoryCandidateSchema>
export type AgentMemoryToolName = z.infer<typeof AgentMemoryToolNameSchema>
export type AgentMemoryToolManifest = z.infer<typeof AgentMemoryToolManifestSchema>
export type AgentMemorySkillManifest = z.infer<typeof AgentMemorySkillManifestSchema>
export type AgentMemoryExtractorInput = z.infer<typeof AgentMemoryExtractorInputSchema>
export type AgentMemoryExtractorOutput = z.infer<typeof AgentMemoryExtractorOutputSchema>
export type ChatMemoryOperationProjection = z.infer<typeof ChatMemoryOperationProjectionSchema>
export type AgentMemoryPromptItem = z.infer<typeof AgentMemoryPromptItemSchema>
export type AgentMemoryRenderedSection = z.infer<typeof AgentMemoryRenderedSectionSchema>
export type AgentMemoryRetrievalSnapshot = z.infer<typeof AgentMemoryRetrievalSnapshotSchema>
export type AgentMemoryRunOptions = z.infer<typeof AgentMemoryRunOptionsSchema>
export type ListAgentMemoryDocumentsQuery = z.infer<typeof ListAgentMemoryDocumentsQuerySchema>
export type AgentMemoryDocument = z.infer<typeof AgentMemoryDocumentSchema>
export type AgentMemoryDocumentsResponse = z.infer<typeof AgentMemoryDocumentsResponseSchema>
export type GetAgentMemoryDocumentParams = z.infer<typeof GetAgentMemoryDocumentParamsSchema>
export type RetrieveAgentMemoryRequest = z.infer<typeof RetrieveAgentMemoryRequestSchema>
export type RetrieveAgentMemoryResponse = z.infer<typeof RetrieveAgentMemoryResponseSchema>
export type ExecuteAgentMemoryOperationProposalsRequest = z.infer<typeof ExecuteAgentMemoryOperationProposalsRequestSchema>
export type ExecuteAgentMemoryOperationProposalsResponse = z.infer<typeof ExecuteAgentMemoryOperationProposalsResponseSchema>
