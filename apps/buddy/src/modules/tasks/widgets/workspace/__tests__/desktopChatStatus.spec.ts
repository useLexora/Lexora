// @vitest-environment jsdom
import type { ChatBlocker } from '../../../model/status/typing'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowReactive } from 'vue'
import DesktopChatStatus from '../DesktopChatStatus.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('desktopChatStatus', () => {
  it('renders model unavailable blocker and emits selectModel on primary action', async () => {
    const emitted: { openSettings: string[], selectModel: number } = { openSettings: [], selectModel: 0 }
    const props = shallowReactive({
      blocker: { dismissible: true, kind: 'model' as const, reason: 'unavailable' as const } as ChatBlocker | null,
      canRestartRuntime: false,
      language: 'zh-CN' as const,
      runtimeError: null as string | null,
      runtimeStatus: 'ready' as const,
    })

    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup: () => () => h(DesktopChatStatus, {
        ...props,
        onOpenSettings: (cat: string) => emitted.openSettings.push(cat),
        onSelectModel: () => emitted.selectModel++,
      }),
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()

    expect(root.textContent).toContain('需要选择模型')
    expect(root.textContent).toContain('当前对话选中的模型不可用，请重新选择模型后继续。')
    expect(root.textContent).toContain('选择模型')

    const actionButton = root.querySelector<HTMLButtonElement>('.desktop-chat-page__alert-actions .n-button--primary-type')!
    expect(actionButton).not.toBeNull()
    actionButton.click()
    await nextTick()

    expect(emitted.selectModel).toBe(1)
    expect(emitted.openSettings).toHaveLength(0)

    // Switch to no_models blocker
    props.blocker = { dismissible: true, kind: 'no_models' }
    await nextTick()

    expect(root.textContent).toContain('缺少可用模型')
    expect(root.textContent).toContain('当前已连接的模型服务中没有可用模型。配置或启用模型后才能发送消息。')
    expect(root.textContent).toContain('配置模型')

    actionButton.click()
    await nextTick()

    expect(emitted.openSettings).toEqual(['models'])
  })
})
