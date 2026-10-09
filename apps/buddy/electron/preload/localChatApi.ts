import type { LocalChatApi } from '../shared/localChatApi'
import { createActivityApi } from './local-chat/activity'
import { createAutomationsApi } from './local-chat/automations'
import { createComposerApi } from './local-chat/composer'
import { createConnectorsApi } from './local-chat/connectors'
import { createConversationApi } from './local-chat/conversation'
import { createPromptsApi } from './local-chat/prompts'
import { createProvidersApi } from './local-chat/providers'
import { createRuntimeApi } from './local-chat/runtime'
import { createSkillsApi } from './local-chat/skills'
import { createSpacesApi } from './local-chat/spaces'
import { createTaskMarksApi } from './local-chat/taskMarks'
import { createWebApi } from './local-chat/web'

export function createLocalChatApi(): LocalChatApi {
  return Object.freeze({
    ...createActivityApi(),
    ...createAutomationsApi(),
    ...createRuntimeApi(),
    ...createPromptsApi(),
    ...createProvidersApi(),
    ...createSpacesApi(),
    ...createSkillsApi(),
    ...createConnectorsApi(),
    ...createConversationApi(),
    ...createTaskMarksApi(),
    ...createWebApi(),
    ...createComposerApi(),
  })
}
