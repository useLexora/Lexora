import type { DesktopNotificationTestResult } from '../../shared/notifications/desktopNotification'
import type { LexoraConfig } from '../shared/desktopApi'
import type { DesktopNotificationSettings } from './desktopNotificationPolicy'
import type { DesktopRuntimeGateway } from './localChatIpc'
import { conversationResponseSchemas } from '../../shared/conversation/conversationApi'
import { executionPresentationRpc } from '../../shared/executions/executionPresentationApi'
import { runsRequestSchemas, runsResponseSchemas } from '../../shared/runs/runApi'

import { shouldShowDesktopNotification } from './desktopNotificationPolicy'

export interface DesktopNotificationInput {
  body: string
  title: string
  silent?: boolean
}

export interface DesktopSystemNotification {
  onClick: (listener: () => void) => void
  onShow: (listener: () => void) => void
  onFailed: (listener: () => void) => void
  show: () => void
}

export interface DesktopNotificationTarget {
  conversationId: string
  runId: string
}

export interface DesktopNotificationServiceOptions {
  createNotification: (input: DesktopNotificationInput) => DesktopSystemNotification
  getLanguage: () => LexoraConfig['desktop']['language']
  getSettings: () => DesktopNotificationSettings
  getSoundSelection: () => string
  playSound: (isEligible: () => boolean, source: 'task' | 'test') => void
  isSupported: () => boolean
  isWindowFocused: () => boolean
  openApp: () => void
  openTarget: (target: DesktopNotificationTarget) => Promise<void> | void
  request: DesktopRuntimeGateway['request']
}

const BODY_LABELS = {
  'zh-CN': {
    task: {
      'approval.requested': '等待你的确认',
      'run.completed': '任务已完成',
      'run.failed': '任务失败',
    },
    subtask: {
      'approval.requested': '子任务等待你的确认',
      'run.completed': '子任务已完成',
      'run.failed': '子任务失败',
    },
    subtaskName: '子任务',
    untitled: '未命名对话',
    testTitle: 'Lexora · 测试通知',
    testBody: '这是一条测试通知，用于确认通知横幅与提示音。',
  },
  'en-US': {
    task: {
      'approval.requested': 'Waiting for your approval',
      'run.completed': 'Task completed',
      'run.failed': 'Task failed',
    },
    subtask: {
      'approval.requested': 'Subtask waiting for your approval',
      'run.completed': 'Subtask completed',
      'run.failed': 'Subtask failed',
    },
    subtaskName: 'Subtask',
    untitled: 'Untitled conversation',
    testTitle: 'Lexora · Test notification',
    testBody: 'This is a test notification to check the banner and sound.',
  },
} as const

export class DesktopNotificationService {
  readonly #options: DesktopNotificationServiceOptions
  readonly #shownEvents = new Set<string>()
  readonly #pendingEvents = new Set<string>()
  #testing: Promise<DesktopNotificationTestResult> | null = null

  constructor(options: DesktopNotificationServiceOptions) {
    this.#options = options
  }

  async test(): Promise<DesktopNotificationTestResult> {
    if (!this.#options.isSupported())
      return 'unavailable'
    if (this.#testing)
      return this.#testing
    const labels = BODY_LABELS[this.#options.getLanguage()]
    this.#testing = new Promise<DesktopNotificationTestResult>((resolve) => {
      let failed = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: DesktopNotificationTestResult) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        failed = result !== 'shown'
        resolve(result)
      }
      timer = setTimeout(finish, 5000, 'failed')
      try {
        const notification = this.#createNotification({ title: labels.testTitle, body: labels.testBody }, () => !failed, 'test')
        notification.onClick(this.#options.openApp)
        notification.onShow(() => finish('shown'))
        notification.onFailed(() => finish('failed'))
        notification.show()
      }
      catch {
        finish('failed')
      }
    })
    try {
      return await this.#testing
    }
    finally {
      this.#testing = null
    }
  }

  async handle(notification: { method: string, params: unknown }): Promise<void> {
    if (notification.method !== 'run.event')
      return
    const event = runsRequestSchemas.runStateEvent.safeParse(notification.params)
    if (!event.success)
      return
    const eventKey = `${event.data.runId}:${event.data.sequence}:${event.data.type}`
    if (this.#shownEvents.has(eventKey) || this.#pendingEvents.has(eventKey))
      return
    if (!shouldShowDesktopNotification({
      eventType: event.data.type,
      isWindowFocused: this.#options.isWindowFocused(),
      settings: this.#options.getSettings(),
    })) {
      return
    }

    this.#pendingEvents.add(eventKey)
    try {
      const run = runsResponseSchemas.run.parse(
        await this.#options.request('runs.get', { runId: event.data.runId }),
      )
      const [conversationResult, executionsResult] = await Promise.all([
        this.#options.request('conversations.get', { conversationId: run.conversationId }),
        this.#options.request('executions.list', { conversationId: run.conversationId, branchId: run.branchId }),
      ])
      const conversation = conversationResponseSchemas.conversation.parse(conversationResult)
      const execution = executionPresentationRpc.list.response.parse(executionsResult).find(item => item.runId === run.id)
      if (!execution)
        return
      const isSubtask = execution.kind === 'npc_child' || execution.kind === 'actor_child'
      if (!shouldShowDesktopNotification({
        eventType: event.data.type,
        isSubtask,
        isWindowFocused: this.#options.isWindowFocused(),
        settings: this.#options.getSettings(),
      })) {
        return
      }
      const labels = BODY_LABELS[this.#options.getLanguage()]
      const eventType = event.data.type as keyof typeof labels.task
      const title = conversation.title?.trim() || labels.untitled
      const task = execution.task.replace(/\s+/g, ' ').trim()
      const systemNotification = this.#createNotification({
        body: isSubtask
          ? [`${execution.buddyName} · ${labels.subtask[eventType]}`, task].filter(Boolean).join('\n')
          : labels.task[eventType],
        title: isSubtask ? `${labels.subtaskName} #${execution.ordinal} · ${title}` : title,
      }, () => shouldShowDesktopNotification({
        eventType: event.data.type,
        isSubtask,
        isWindowFocused: this.#options.isWindowFocused(),
        settings: this.#options.getSettings(),
      }), 'task')
      systemNotification.onClick(() => {
        void this.#options.openTarget({
          conversationId: run.conversationId,
          runId: run.id,
        })
      })
      systemNotification.show()
      this.#shownEvents.add(eventKey)
    }
    finally {
      this.#pendingEvents.delete(eventKey)
    }
  }

  #createNotification(input: DesktopNotificationInput, isEligible: () => boolean, source: 'task' | 'test'): DesktopSystemNotification {
    const selection = this.#options.getSoundSelection()
    const notification = this.#options.createNotification({ ...input, ...(selection !== 'system' ? { silent: true } : {}) })
    if (selection !== 'system') {
      let sounded = false
      notification.onShow(() => {
        if (sounded)
          return
        sounded = true
        this.#options.playSound(() => this.#options.getSoundSelection() === selection && isEligible(), source)
      })
    }
    return notification
  }
}
