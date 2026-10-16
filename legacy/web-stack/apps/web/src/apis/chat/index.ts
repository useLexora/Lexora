import type {
  BatchDeleteChatSessionsRequest,
  BatchDeleteChatSessionsResponse,
  ChatModelListResponse,
  ChatModelSelection,
  ChatMutationResponse,
  ChatRuntimeConfig,
  ChatSessionDetail,
  ChatSessionEvent,
  ChatSessionOrigin,
  ChatSessionSummary,
  ChatUploadedAsset,
  CreateChatSessionMessageRequest,
  EditAndSendChatMessageRequest,
  ResumeChatRunRequest,
  RetryChatAssistantMessageRequest,
  SwitchChatActiveMessageRequest,
  UpdateChatSessionTitleRequest,
} from './typing'
import { ChatSessionEventSchema } from '@haohaoxue/lexora-contracts/chat'
import { CHAT_SESSION_EVENT_TYPE, CHAT_SESSION_ORIGIN } from '@haohaoxue/lexora-contracts/chat/constants'
import { SERVER_PATH } from '@haohaoxue/lexora-contracts/server'
import { getChatStreamingProbe } from '@/composables/chat/utils/chat-streaming-probe'
import { useAuthStore } from '@/stores/auth'
import { axios } from '@/utils/axios'
import { createRequestError, createRequestErrorFromHttpResponse, toRequestError } from '@/utils/request-error'

export * from './typing'

const API_BASE_URL = SERVER_PATH
const DEFAULT_CHAT_SESSION_ORIGIN = CHAT_SESSION_ORIGIN.GLOBAL

interface ChatSessionOriginOptions {
  origin?: ChatSessionOrigin
}

interface ChatSessionWorkspaceOptions extends ChatSessionOriginOptions {
  workspaceId: string
}

export function getChatSessions(options: ChatSessionWorkspaceOptions): Promise<ChatSessionSummary[]> {
  return axios.request({
    method: 'get',
    url: '/chat/sessions',
    params: createChatSessionWorkspaceParams(options),
  })
}

export function createChatSession(options: ChatSessionWorkspaceOptions): Promise<ChatSessionDetail> {
  return axios.request({
    method: 'post',
    url: '/chat/sessions',
    data: {
      workspaceId: options.workspaceId,
      origin: resolveChatSessionOrigin(options),
    },
  })
}

export function getChatSession(sessionId: string, options: ChatSessionOriginOptions = {}): Promise<ChatSessionDetail> {
  return axios.request({
    method: 'get',
    url: `/chat/sessions/${sessionId}`,
    params: createChatSessionOriginParams(options),
  })
}

export function deleteChatSession(sessionId: string, options: ChatSessionOriginOptions = {}): Promise<null> {
  return axios.request({
    method: 'delete',
    url: `/chat/sessions/${sessionId}`,
    params: createChatSessionOriginParams(options),
  })
}

export function batchDeleteChatSessions(
  data: BatchDeleteChatSessionsRequest,
  options: ChatSessionOriginOptions = {},
): Promise<BatchDeleteChatSessionsResponse> {
  return axios.request({
    method: 'post',
    url: '/chat/sessions/batch-delete',
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function updateChatSessionModel(
  sessionId: string,
  data: ChatModelSelection,
  options: ChatSessionOriginOptions = {},
): Promise<ChatSessionDetail> {
  return axios.request({
    method: 'patch',
    url: `/chat/sessions/${sessionId}/model`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function updateChatSessionTitle(
  sessionId: string,
  data: UpdateChatSessionTitleRequest,
  options: ChatSessionOriginOptions = {},
): Promise<ChatSessionDetail> {
  return axios.request({
    method: 'patch',
    url: `/chat/sessions/${sessionId}/title`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function sendChatSessionMessage(
  sessionId: string,
  data: CreateChatSessionMessageRequest,
  options: ChatSessionOriginOptions = {},
): Promise<ChatMutationResponse> {
  return axios.request({
    method: 'post',
    url: `/chat/sessions/${sessionId}/messages`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function editAndSendChatMessage(
  sessionId: string,
  messageId: string,
  data: EditAndSendChatMessageRequest,
  options: ChatSessionOriginOptions = {},
): Promise<ChatMutationResponse> {
  return axios.request({
    method: 'post',
    url: `/chat/sessions/${sessionId}/messages/${messageId}/edit-and-send`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function retryChatAssistantMessage(
  sessionId: string,
  messageId: string,
  data: RetryChatAssistantMessageRequest = {},
  options: ChatSessionOriginOptions = {},
): Promise<ChatMutationResponse> {
  return axios.request({
    method: 'post',
    url: `/chat/sessions/${sessionId}/messages/${messageId}/retry`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function switchChatActiveMessage(
  sessionId: string,
  data: SwitchChatActiveMessageRequest,
  options: ChatSessionOriginOptions = {},
): Promise<ChatMutationResponse> {
  return axios.request({
    method: 'patch',
    url: `/chat/sessions/${sessionId}/active-message`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function cancelChatRun(runId: string, options: ChatSessionOriginOptions = {}): Promise<ChatMutationResponse> {
  return axios.request({
    method: 'post',
    url: `/chat/runs/${runId}/cancel`,
    params: createChatSessionOriginParams(options),
  })
}

export function resumeChatRun(
  runId: string,
  data: ResumeChatRunRequest,
  options: ChatSessionOriginOptions = {},
): Promise<ChatMutationResponse> {
  return axios.request({
    method: 'post',
    url: `/chat/runs/${runId}/resume`,
    params: createChatSessionOriginParams(options),
    data,
  })
}

export function getChatRuntimeConfig(): Promise<ChatRuntimeConfig> {
  return axios.request({
    method: 'get',
    url: '/chat/config',
  })
}

export function getChatModels(): Promise<ChatModelListResponse> {
  return axios.request({
    method: 'get',
    url: '/chat/models',
  })
}

export function uploadChatImage(workspaceId: string, file: File): Promise<ChatUploadedAsset> {
  return uploadChatAsset('/chat/assets/images', workspaceId, file)
}

export function uploadChatFile(workspaceId: string, file: File): Promise<ChatUploadedAsset> {
  return uploadChatAsset('/chat/assets/files', workspaceId, file)
}

export async function streamChatSessionEvents(
  sessionId: string,
  afterSequence: number | null,
  onEvent: (event: ChatSessionEvent) => void | Promise<void>,
  options: {
    origin?: ChatSessionOrigin
    signal?: AbortSignal
  } = {},
): Promise<void> {
  const authStore = useAuthStore()
  const query = createChatSessionEventQuery({
    afterSequence,
    origin: options.origin,
  })

  const response = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}/events${query}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authStore.accessToken}`,
    },
    signal: options.signal,
  })

  if (!response.ok) {
    throw await readApiError(response)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw createRequestError({
      source: 'stream',
      message: 'no response body',
    })
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) {
          continue
        }

        let payload: unknown = null
        try {
          payload = JSON.parse(trimmed.slice(6))
        }
        catch {
          continue
        }

        const parsedEvent = ChatSessionEventSchema.safeParse(payload)
        if (parsedEvent.success) {
          const event = parsedEvent.data
          const probe = getChatStreamingProbe()

          if (!probe) {
            await onEvent(event)
            continue
          }

          const startedAt = performance.now()
          const marker = getChatEventMarker(event)
          probe.recordChatEvent?.({
            phase: 'received',
            eventType: event.type,
            sequence: event.sequence,
            messageId: event.messageId,
            runId: event.runId,
            marker,
            time: startedAt,
          })

          await onEvent(event)

          const endedAt = performance.now()
          probe.recordChatEvent?.({
            phase: 'applied',
            eventType: event.type,
            sequence: event.sequence,
            messageId: event.messageId,
            runId: event.runId,
            marker,
            durationMs: endedAt - startedAt,
            time: endedAt,
          })
        }
      }
    }
  }
  catch (error) {
    if (options.signal?.aborted) {
      throw error
    }

    throw toRequestError(error, {
      source: 'stream',
    })
  }
  finally {
    reader.releaseLock()
  }
}

async function readApiError(response: Response) {
  return createRequestErrorFromHttpResponse(response, {
    source: 'stream',
  })
}

function createChatSessionOriginParams(options: ChatSessionOriginOptions): { origin: ChatSessionOrigin } {
  return {
    origin: resolveChatSessionOrigin(options),
  }
}

function createChatSessionWorkspaceParams(options: ChatSessionWorkspaceOptions): { origin: ChatSessionOrigin, workspaceId: string } {
  return {
    ...createChatSessionOriginParams(options),
    workspaceId: options.workspaceId,
  }
}

function uploadChatAsset(url: string, workspaceId: string, file: File): Promise<ChatUploadedAsset> {
  const formData = new FormData()
  formData.append('file', file)

  return axios.request({
    method: 'post',
    url,
    params: {
      workspaceId,
    },
    data: formData,
  })
}

function resolveChatSessionOrigin(options: ChatSessionOriginOptions): ChatSessionOrigin {
  return options.origin ?? DEFAULT_CHAT_SESSION_ORIGIN
}

function createChatSessionEventQuery(input: {
  afterSequence: number | null
  origin?: ChatSessionOrigin
}): string {
  const params = new URLSearchParams()
  if (input.afterSequence !== null) {
    params.set('afterSequence', String(input.afterSequence))
  }
  params.set('origin', input.origin ?? DEFAULT_CHAT_SESSION_ORIGIN)

  const query = params.toString()
  return query ? `?${query}` : ''
}

function getChatEventMarker(event: ChatSessionEvent): string | null {
  if (event.type !== CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA) {
    return null
  }

  return event.payload.delta.match(/\[\[stream-marker-\d+\]\]/)?.[0] ?? null
}
