import type { UserQuestionAnswer, UserQuestionRequest } from '@buddy-shared/questions/userQuestionApi'
import { shallowRef } from 'vue'

export type UserQuestionFormDefinition = Pick<UserQuestionRequest, 'id' | 'buddyName' | 'questions'>

export function createUserQuestionInteractionState() {
  return {
    drafts: shallowRef(new Map<string, UserQuestionAnswer[]>()),
    expandedIds: shallowRef(new Set<string>()),
    selectedByScope: shallowRef(new Map<string, string>()),
    selectedQuestionIds: shallowRef(new Map<string, string>()),
    resolvingIds: shallowRef(new Set<string>()),
    errors: shallowRef(new Set<string>()),
  }
}
