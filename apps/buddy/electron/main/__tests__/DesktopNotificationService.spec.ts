import { describe, expect, it, vi } from 'vitest'
import { DesktopNotificationService } from '../DesktopNotificationService'

describe('desktopNotificationService', () => {
  it('shows one generic conversation notification and opens its target', async () => {
    let click: (() => void) | null = null
    const show = vi.fn()
    const openTarget = vi.fn()
    const notifications: { body: string, title: string }[] = []
    const service = new DesktopNotificationService({
      createNotification(input) {
        notifications.push(input)
        return {
          onClick(listener) {
            click = listener
          },
          show,
        }
      },
      getLanguage: () => 'zh-CN',
      getSettings: () => ({ notificationsEnabled: true, notifyWhenFocused: false }),
      isWindowFocused: () => false,
      openTarget,
      request: async (method) => {
        if (method === 'runs.get') {
          return {
            approvalPolicy: 'policy',
            buddyId: 'default',
            branchId: 'branch-1',
            completedAt: '2026-08-19T08:00:00.000Z',
            conversationId: 'conversation-1',
            errorCode: null,
            executionProfile: 'workspace_write',
            id: 'run-1',
            modelId: 'gpt-5',
            providerId: 'openai',
            purpose: 'chat',
            reasoningLevel: 'high',
            startedAt: '2026-08-19T07:59:00.000Z',
            status: 'completed',
            triggeringMessageId: 'message-1',
          }
        }
        return {
          buddyId: 'default',
          activeBranchId: 'branch-1',
          approvalPolicy: 'policy',
          createdAt: '2026-08-19T07:58:00.000Z',
          deletedAt: null,
          executionProfile: 'workspace_write',
          id: 'conversation-1',
          modelSelection: null,
          spaceId: null,
          title: '整理发布说明',
          updatedAt: '2026-08-19T08:00:00.000Z',
        }
      },
    })
    const notification = {
      method: 'run.event',
      params: {
        createdAt: '2026-08-19T08:00:00.000Z',
        payload: { errorCode: null },
        runId: 'run-1',
        sequence: 8,
        type: 'run.completed',
      },
    }

    await service.handle(notification)
    await service.handle(notification)

    expect(notifications).toEqual([{ body: '任务已完成', title: '整理发布说明' }])
    expect(show).toHaveBeenCalledOnce()
    expect(click).not.toBeNull()
    click!()
    expect(openTarget).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      runId: 'run-1',
    })
  })
})
