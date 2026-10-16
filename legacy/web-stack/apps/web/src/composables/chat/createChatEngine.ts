import type { ChatSessionPersistence } from './createChatSessionController'
import type { ChatStreamControllerOptions } from './createChatStreamController'
import type { ChatSessionOrigin } from '@/apis/chat'
import { createChatApi } from './createChatApi'
import { createChatComposerModelController } from './createChatComposerModelController'
import { createChatRuntimeOverlay } from './createChatRuntimeOverlay'
import { createChatSessionController } from './createChatSessionController'
import { createChatSessionEvents } from './createChatSessionEvents'
import { createChatStreamController } from './createChatStreamController'

export interface ChatEngineOptions {
  getWorkspaceId: () => string | null | undefined
  onSessionCreated?: ChatStreamControllerOptions['onSessionCreated']
  persistence?: ChatSessionPersistence
}

export function createChatEngine(origin: ChatSessionOrigin, options: ChatEngineOptions) {
  const api = createChatApi(origin, {
    getWorkspaceId: options.getWorkspaceId,
  })
  const sessions = createChatSessionController(api, { persistence: options.persistence })
  const events = createChatSessionEvents(api)
  const overlay = createChatRuntimeOverlay(sessions)
  const stream = createChatStreamController(sessions, overlay, events, api, {
    onSessionCreated: options.onSessionCreated,
  })
  const model = createChatComposerModelController(sessions, api)

  return {
    sessions,
    events,
    overlay,
    stream,
    model,
  }
}

export type ChatEngine = ReturnType<typeof createChatEngine>
