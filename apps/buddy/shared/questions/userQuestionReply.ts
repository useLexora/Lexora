import type { UserQuestion, UserQuestionAnswer, UserQuestionRequest } from './userQuestionApi'

export function formatUserQuestionAnswer(question: UserQuestion, answer: UserQuestionAnswer | undefined): string {
  return answer ? [...question.options.filter(option => answer.selectedOptionIds.includes(option.id)).map(option => option.label), answer.text].filter(Boolean).join('\n') : ''
}

export function renderUserQuestionReply(request: UserQuestionRequest): string {
  return JSON.stringify({
    kind: 'user_question_reply',
    requestId: request.id,
    sourceRunId: request.runId,
    status: request.status,
    questions: request.questions.map(({ id, question, options }) => ({ id, question, options: options.map(({ id, label }) => ({ id, label })) })),
    response: request.response,
  })
}

export function userQuestionReplyText(request: UserQuestionRequest): string {
  return request.questions.map(question => `${question.question}\n${formatUserQuestionAnswer(question, request.response?.answers.find(answer => answer.questionId === question.id))}`).join('\n\n')
}
