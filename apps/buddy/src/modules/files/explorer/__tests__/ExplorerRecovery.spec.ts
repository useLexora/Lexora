// @vitest-environment jsdom
import type { SpaceFileOperation } from '@buddy-shared/spaces/spaceFileApi'
import { NDialogProvider } from 'naive-ui'
import { expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ExplorerRecovery from '../ExplorerRecovery.vue'

it.each([
  { language: 'zh-CN', source: '源路径', destination: '目标路径', operation: '复制', accept: '接受当前状态', cancel: '取消', consequence: '不会修复文件、重做上次操作或删除临时文件' },
  { language: 'en-US', source: 'Source', destination: 'Destination', operation: 'Copy', accept: 'Accept current state', cancel: 'Cancel', consequence: 'does not repair files, replay the operation or delete temporary files' },
])('explains both endpoints and requires an explicit state acceptance in $language', async (labels) => {
  const operation: SpaceFileOperation = {
    operationId: '97e376aa-2fda-4e39-b257-e54bb391d56f',
    kind: 'copy',
    path: 'source.txt',
    destination: 'copies/target.txt',
    temporaryPath: 'copies/.temporary',
    status: 'needs-recovery',
    error: null,
    createdAt: 1,
    updatedAt: 2,
    restorable: false,
  }
  const accepted: SpaceFileOperation[] = []
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    render: () => h(NDialogProvider, {}, {
      default: () => h(ExplorerRecovery, {
        operations: [operation],
        language: labels.language,
        busy: false,
        onAcknowledge: value => accepted.push(value),
      }),
    }),
  })
  app.mount(root)
  try {
    expect(root.textContent).toContain(labels.operation)
    expect(root.textContent).toContain(`${labels.source}: source.txt`)
    expect(root.textContent).toContain(`${labels.destination}: copies/target.txt`)
    expect(root.textContent).toContain('copies/.temporary')
    const open = root.querySelector<HTMLButtonElement>('button')!
    expect(open.textContent).toContain(labels.accept)
    open.click()
    await nextTick()
    const dialog = document.querySelector('.n-dialog')!
    expect(dialog.textContent).toContain(labels.consequence)
    expect(accepted).toEqual([])
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    buttons.find(button => button.textContent?.trim() === labels.cancel)!.click()
    await nextTick()
    expect(accepted).toEqual([])
    open.click()
    await nextTick()
    const dialogs = [...document.querySelectorAll('.n-dialog')]
    const confirm = [...dialogs.at(-1)!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === labels.accept)!
    confirm.click()
    await nextTick()
    expect(accepted).toEqual([operation])
  }
  finally {
    app.unmount()
    root.remove()
  }
})
