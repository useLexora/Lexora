// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionTaskCleanupConfirmation } from '@buddy-shared/extensions/extensionTaskCleanup'
import type { ExtensionContext } from '../../extensionContext'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { deferred } from '@buddy-tests/deferred'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, shallowRef } from 'vue'
import { useProvideExtensionContext } from '../../extensionContext'
import { useExtensionState } from '../../state/useExtensionState'
import DesktopExtensionTaskCleanupHost from '../DesktopExtensionTaskCleanupHost.vue'

const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }))
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})
const confirmation: ExtensionTaskCleanupConfirmation = { id: 'confirmation-1', extensionId: 'test.cleanup', total: 3, skipped: 2 }
async function mount() {
  let requests = [confirmation]
  const listeners = new Set<() => void>()
  const decisions: { id: string, operationId: string, confirmed: boolean }[] = []
  const snapshot: ExtensionStatus = {
    manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'test.cleanup', name: '旧版任务清理', version: '1.0.2', apiVersion: 4, engines: { lexora: '*' }, contributes: {} }),
    revision: 'revision',
    enabled: true,
    development: false,
    compatible: true,
    pending: null,
    state: 'active',
    generation: 'generation',
    error: null,
    activationMs: null,
    logs: [],
  }
  const api: Partial<ExtensionApi> = {
    list: async () => [snapshot],
    unavailable: async () => [],
    taskActions: async () => [],
    installations: async () => [],
    onInstallationsChanged: () => () => {},
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    taskCleanupConfirmations: async () => requests,
    confirmTaskCleanup: async (id, operationId, confirmed) => {
      decisions.push({ id, operationId, confirmed })
      requests = []
    },
  }
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ setup() {
    const state = useExtensionState(api as ExtensionApi)
    void state.refresh()
    useProvideExtensionContext({ state, language: shallowRef('zh-CN') } as ExtensionContext)
    return () => h(NMessageProvider, null, { default: () => h(DesktopExtensionTaskCleanupHost) })
  } })
  app.mount(root)
  cleanups.push(() => app.unmount())
  await vi.waitFor(() => expect(dialog()).not.toBeNull())
  return { api, decisions, update(next: ExtensionTaskCleanupConfirmation[]) {
    requests = next
    listeners.forEach(listener => listener())
  } }
}
function dialog() {
  return document.querySelector<HTMLElement>('[data-testid="extension-task-cleanup-dialog"]')
}
function button(label: string) {
  const found = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
  expect(found, label).toBeDefined()
  return found!
}

it.each([['取消', false], ['删除', true]] as const)('binds %s to the frozen request and withdraws the confirmation afterwards', async (label, confirmed) => {
  const f = await mount()
  expect(dialog()!.textContent).toContain('删除后无法恢复')
  expect(dialog()!.textContent).toContain('不处理活动或已归档任务')
  expect(dialog()!.textContent).toContain('不影响用户工作区及外部文件')
  expect(dialog()!.querySelector('[data-testid="extension-task-cleanup-scope"]')?.textContent).toContain('3')
  expect(dialog()!.textContent).toContain('2 项暂不可清理')
  button(label).click()
  await vi.waitFor(() => expect(dialog()).toBeNull())
  expect(f.decisions).toEqual([{ id: 'test.cleanup', operationId: 'confirmation-1', confirmed }])
})

it('ignores a late response from an old confirmation without disabling its replacement', async () => {
  const f = await mount()
  const old = deferred<void>()
  f.api.confirmTaskCleanup = () => old.promise
  button('删除').click()
  await vi.waitFor(() => expect(button('取消').disabled).toBe(true))
  f.update([{ ...confirmation, id: 'confirmation-2', total: 7 }])
  await vi.waitFor(() => expect(dialog()!.querySelector('[data-testid="extension-task-cleanup-scope"]')?.textContent).toContain('7'))
  old.reject(new Error('EXTENSION_TASK_CLEANUP_EXPIRED'))
  await vi.waitFor(() => expect(button('取消').disabled).toBe(false))
  expect(dialog()!.textContent).not.toContain('本次确认已失效')
})

it('preserves a known confirmation when refresh fails, without treating failure as no pending request', async () => {
  const f = await mount()
  f.api.taskCleanupConfirmations = async () => {
    throw new Error('PRIVATE_PATH')
  }
  f.update([])
  await vi.waitFor(() => expect(dialog()!.textContent).toContain('未能更新确认信息'))
  expect(dialog()!.querySelector('[data-testid="extension-task-cleanup-scope"]')?.textContent).toContain('3')
  f.api.taskCleanupConfirmations = async () => []
  button('取消').click()
  await vi.waitFor(() => expect(dialog()).toBeNull())
  expect(f.decisions[0]?.confirmed).toBe(false)
})
