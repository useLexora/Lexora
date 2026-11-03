import type { RuntimeRequestContract } from '../runtime/apiContract'
import { z } from 'zod'
import { executionScopeSchema } from '../executions/executionPresentationApi'
import { idSchema, timestampSchema } from '../runtime/apiValidation'

export const ASK_USER_TOOL_NAME = 'lexora_ask_user'
export const WAIT_USER_TOOL_NAME = 'lexora_wait_user'
const key = z.string().trim().min(1).max(80)
export const userQuestionSchema = z.object({
  id: key,
  question: z.string().trim().min(1).max(2000),
  kind: z.enum(['single', 'multiple', 'text']),
  options: z.array(z.object({
    id: key,
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(500).optional(),
    recommended: z.boolean().optional(),
  }).strict()).max(6),
}).strict().refine(value => value.kind === 'text' ? value.options.length === 0 : value.options.length >= 2, 'Choices require at least two options; text questions have none').refine(value => new Set(value.options.map(option => option.id)).size === value.options.length, 'Option IDs must be unique')

export const askUserInputSchema = z.object({ questions: z.array(userQuestionSchema).min(1).max(3) }).strict().refine(value => new Set(value.questions.map(question => question.id)).size === value.questions.length, 'Question IDs must be unique')
export const userQuestionAnswerSchema = z.object({
  questionId: key,
  selectedOptionIds: z.array(key).max(6),
  text: z.string().max(8000),
}).strict()
export const userQuestionResponseSchema = z.object({
  answers: z.array(userQuestionAnswerSchema).min(1).max(3),
}).strict()
export const userQuestionRequestSchema = executionScopeSchema.extend({
  id: idSchema,
  runId: idSchema,
  rootRunId: idSchema,
  toolCallId: idSchema.optional(),
  mode: z.enum(['blocking', 'async']).optional(),
  delivery: z.object({
    state: z.enum(['pending', 'delivered', 'failed']),
    targetRunId: idSchema.nullable(),
  }).strict().optional(),
  buddyName: z.string(),
  questions: askUserInputSchema.shape.questions,
  status: z.enum(['pending', 'answered', 'cancelled', 'interrupted']),
  response: userQuestionResponseSchema.nullable(),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
}).strict()
const target = executionScopeSchema.extend({ requestId: idSchema }).strict()
export const userQuestionRpc = {
  list: { method: 'questions.list', input: executionScopeSchema, response: z.array(userQuestionRequestSchema) },
  answer: { method: 'questions.answer', input: target.extend(userQuestionResponseSchema.shape).strict(), response: userQuestionRequestSchema },
  cancel: { method: 'questions.cancel', input: target, response: userQuestionRequestSchema },
  retry: { method: 'questions.retry', input: target, response: userQuestionRequestSchema },
} as const satisfies Record<string, RuntimeRequestContract>
export const userQuestionsChanged = { method: 'questions.changed', params: executionScopeSchema.extend({ runId: idSchema }).strict() } as const
export type AskUserInput = z.infer<typeof askUserInputSchema>
export type UserQuestion = z.infer<typeof userQuestionSchema>
export type UserQuestionAnswer = z.infer<typeof userQuestionAnswerSchema>
export type UserQuestionResponse = z.infer<typeof userQuestionResponseSchema>
export type UserQuestionRequest = z.infer<typeof userQuestionRequestSchema>
export type UserQuestionTarget = z.infer<typeof target>
export type UserQuestionSubmit = z.infer<typeof userQuestionRpc.answer.input>
export type UserQuestionsChanged = z.infer<typeof userQuestionsChanged.params>

export function validateUserQuestionResponse(questions: readonly UserQuestion[], input: UserQuestionResponse): UserQuestionResponse {
  const response = userQuestionResponseSchema.parse(input)
  if (response.answers.length !== questions.length || new Set(response.answers.map(answer => answer.questionId)).size !== questions.length)
    throw new Error('QUESTION_ANSWER_INVALID')
  return { answers: questions.map((question) => {
    const answer = response.answers.find(value => value.questionId === question.id)
    if (!answer || new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length
      || answer.selectedOptionIds.some(id => !question.options.some(option => option.id === id))
      || (question.kind === 'text' && answer.selectedOptionIds.length > 0)
      || (question.kind === 'single' && answer.selectedOptionIds.length > 1)
      || (!answer.selectedOptionIds.length && !answer.text.trim())) {
      throw new Error('QUESTION_ANSWER_INVALID')
    }
    return { ...answer, selectedOptionIds: question.options.filter(option => answer.selectedOptionIds.includes(option.id)).map(option => option.id) }
  }) }
}
