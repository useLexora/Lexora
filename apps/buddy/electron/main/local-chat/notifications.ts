import type { BrowserWindow } from 'electron'
import type { RegisterLocalChatIpcOptions } from './registrar'
import { artifactsChanged } from '../../../shared/artifacts/artifactApi'
import { automationNotifications } from '../../../shared/automation/automationApi'
import { changesChanged } from '../../../shared/changes/changeApi'
import { connectorNotifications } from '../../../shared/connectors/connectorApi'
import { composerResourcesChanged } from '../../../shared/conversation/composerApi'
import { CONVERSATION_CHANGED, conversationSchema, conversationTimelineChanged } from '../../../shared/conversation/conversationApi'
import { webSettingsChanged } from '../../../shared/network/webApi'
import { notificationsChanged } from '../../../shared/notifications/notificationApi'
import { providerNotifications } from '../../../shared/providers/providerApi'
import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import { runNotifications } from '../../../shared/runs/runApi'
import { runtimeResponseSchemas } from '../../../shared/runtime/serviceState'
import { skillChangedSchema, skillReviewRequested } from '../../../shared/skills/skillApi'
import { spaceChanged } from '../../../shared/spaces/spaceApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerLocalChatNotifications(options: RegisterLocalChatIpcOptions): () => void {
  const stopStateSubscription = options.runtime.onStateChange((state) => {
    const parsed = runtimeResponseSchemas.runtimeState.safeParse(state)
    if (parsed.success)
      sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.runtimeStateChanged, parsed.data)
  })
  const stopNotificationSubscription = options.runtime.onNotification((notification) => {
    if (notification.method === artifactsChanged.method || notification.method === changesChanged.method) {
      const contract = notification.method === artifactsChanged.method ? artifactsChanged : changesChanged
      const event = contract.params.safeParse(notification.params)
      if (event.success)
        sendToRenderer(options.getWindow(), contract === artifactsChanged ? LOCAL_CHAT_IPC_CHANNELS.artifactsChanged : LOCAL_CHAT_IPC_CHANNELS.changesChanged, event.data)
      return
    }
    if (notification.method === spaceChanged.method) {
      const event = spaceChanged.params.safeParse(notification.params)
      if (event.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.spacesChanged, event.data)
      return
    }
    if (notification.method === notificationsChanged.method) {
      const result = notificationsChanged.params.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.notificationsChanged, result.data)
      return
    }
    if (notification.method === composerResourcesChanged.method) {
      const result = composerResourcesChanged.params.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.composerResourcesChanged, result.data)
      return
    }
    if (notification.method === webSettingsChanged.method) {
      const changed = webSettingsChanged.params.safeParse(notification.params)
      if (changed.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.webSettingsChanged, changed.data)
      return
    }
    if (notification.method === conversationTimelineChanged.method) {
      const result = conversationTimelineChanged.params.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.conversationsTimelineChanged, result.data)
      return
    }
    if (notification.method === CONVERSATION_CHANGED) {
      const result = conversationSchema.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.conversationsChanged, result.data)
      return
    }
    if (notification.method === connectorNotifications.changed.method) {
      const result = connectorNotifications.changed.params.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.connectorsChanged, result.data)
      return
    }
    if (notification.method === 'skills.changed') {
      const result = skillChangedSchema.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.skillsChanged, result.data)
      return
    }
    if (notification.method === skillReviewRequested.method) {
      const result = skillReviewRequested.params.safeParse(notification.params)
      if (result.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.skillsReviewRequested, result.data)
      return
    }
    if (notification.method === runNotifications.event.method) {
      const event = runNotifications.event.params.safeParse(notification.params)
      if (event.success) {
        sendToRenderer(
          options.getWindow(),
          LOCAL_CHAT_IPC_CHANNELS.runEvent,
          toPublicRunEvent(event.data),
        )
      }
      return
    }
    if (notification.method === automationNotifications.changed.method) {
      const changed = automationNotifications.changed.params.safeParse(notification.params)
      if (changed.success) {
        sendToRenderer(
          options.getWindow(),
          LOCAL_CHAT_IPC_CHANNELS.automationChanged,
          changed.data.automationId,
        )
      }
      return
    }
    if (notification.method === providerNotifications.changed.method) {
      const changed = providerNotifications.changed.params.safeParse(notification.params)
      if (changed.success)
        sendToRenderer(options.getWindow(), LOCAL_CHAT_IPC_CHANNELS.providersChanged, changed.data)
      return
    }
    if (notification.method === providerNotifications.authChallenge.method) {
      const challenge = providerNotifications.authChallenge.params.safeParse(notification.params)
      if (challenge.success) {
        sendToRenderer(
          options.getWindow(),
          LOCAL_CHAT_IPC_CHANNELS.providerAuthChallenge,
          challenge.data,
        )
      }
    }
  })
  return () => {
    stopNotificationSubscription()
    stopStateSubscription()
  }
}

function sendToRenderer(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed())
    return
  window.webContents.send(channel, payload)
}
