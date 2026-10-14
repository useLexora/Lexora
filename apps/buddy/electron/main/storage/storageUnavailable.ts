import { dirname } from 'node:path'
import { app, shell } from 'electron'
import { showRecoveryWindow } from '../app/DesktopRecoveryWindow'

export class StorageUnavailableError extends Error {
  readonly root: string
  constructor(root: string) {
    super('STORAGE_ROOT_UNAVAILABLE')
    this.root = root
  }
}

export async function showStorageUnavailable(error: StorageUnavailableError): Promise<void> {
  await app.whenReady()
  await showRecoveryWindow({
    title: 'Lexora · 数据目录不可用',
    message: '暂时无法打开原有数据',
    recovery: {
      reason: '数据目录不存在、无法访问，或目录身份与记录不一致。',
      notice: '请重新连接磁盘并检查目录权限。修复后可重试；应用不会自动创建空数据覆盖原记录。',
      privacy: '当前没有启动任务服务或自动化。',
      fields: [{ label: '当前数据目录', value: error.root, localOnly: true }],
      actions: [{ action: 'retry', label: '重试启动' }, { action: 'show_directory', label: '打开上级目录' }, { action: 'quit', label: '退出' }],
      copyDetails: '',
      moreActionsLabel: '更多',
    },
  }, '正在检查数据目录…', async (action) => {
    if (action === 'show_directory') {
      await shell.openPath(dirname(error.root))
      return { done: false }
    }
    if (action === 'retry')
      app.relaunch()
    app.exit(0)
    return { done: true }
  })
}
