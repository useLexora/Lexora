import type { UserQuestionRequest } from './userQuestionApi'
import { formatUserQuestionAnswer } from './userQuestionReply'

export interface UserQuestionHistory {
  readonly id: string
  readonly runId: string
  readonly rootRunId: string
  readonly branchId: string
  readonly buddyName: string
  readonly createdAt: string
  readonly resolvedAt: string | null
  readonly status: Exclude<UserQuestionRequest['status'], 'pending'>
  readonly delivery: UserQuestionRequest['delivery']
  readonly entries: readonly {
    readonly id: string
    readonly question: string
    readonly answer: string
  }[]
}

export function projectUserQuestionHistory(request: UserQuestionRequest): UserQuestionHistory | null {
  if (request.status === 'pending')
    return null
  return Object.freeze({
    id: request.id,
    runId: request.runId,
    rootRunId: request.rootRunId,
    branchId: request.branchId,
    buddyName: request.buddyName,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
    status: request.status,
    delivery: request.delivery && Object.freeze({ ...request.delivery }),
    entries: Object.freeze(request.questions.map((question) => {
      const answer = request.response?.answers.find(answer => answer.questionId === question.id)
      return Object.freeze({
        id: question.id,
        question: question.question,
        answer: formatUserQuestionAnswer(question, answer),
      })
    })),
  })
}
