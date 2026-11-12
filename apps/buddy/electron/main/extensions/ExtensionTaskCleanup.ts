import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ExtensionServicePorts } from '../../../platform/extensions/ExtensionService'
import { dialog } from 'electron'

export function assertTaskCleanupConfirmationSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, owner: BrowserWindow | null): void {
  if (!owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || !owner.isFocused() || owner.webContents.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame || owner.webContents.focusedFrame !== owner.webContents.mainFrame)
    throw new Error('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
}

export function createExtensionTaskCleanupConfirmation(getWindow: () => BrowserWindow | null): NonNullable<ExtensionServicePorts['taskCleanup']>['confirmDelete'] {
  let confirming = false
  return async (session, input, assertCurrent) => {
    assertCurrent()
    const owner = getWindow()
    if (confirming || !owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || !owner.isFocused() || owner.webContents.isDestroyed() || owner.webContents.focusedFrame?.url !== session.url)
      throw new Error('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
    confirming = true
    try {
      const result = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: '永久清理旧版已移除任务',
        message: '永久删除此旧版已移除任务？',
        detail: `任务标识：${input.conversationId}\n\n将删除该任务的本地历史和宿主管理的数据，无法撤销。不会删除用户工作区的原文件。任务状态已变化时会拒绝删除。`,
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      assertCurrent()
      if (getWindow() !== owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized())
        throw new Error('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
      return result.response === 1
    }
    finally {
      confirming = false
    }
  }
}
