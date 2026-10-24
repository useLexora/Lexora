// @vitest-environment jsdom
import type { DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopBrowserErrorPage from '../DesktopBrowserErrorPage.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

it('explains network and security failures without exposing raw URLs or offering a certificate bypass', async () => {
  const state = shallowRef<DesktopBrowserState>({
    zoomFactor: 1,
    canGoBack: false,
    canGoForward: false,
    controller: 'human',
    controlEpoch: 0,
    conversationId: null,
    error: { code: 'BROWSER_PAGE_FAILED', message: 'ERR_EMPTY_RESPONSE (-324) loading \'https://user:secret@example.com/\'' },
    pageId: 'page',
    profileMode: 'default',
    security: { kind: 'blank', origin: null },
    sessionId: 'session',
    status: 'error',
    title: '',
    url: 'https://user:secret@example.com/',
    visible: true,
  })
  const initializationFailed = shallowRef(false)
  const root = document.createElement('div')
  const app = createApp({ setup: () => () => h(DesktopBrowserErrorPage, { state: state.value, initializationFailed: initializationFailed.value, language: 'zh-CN' }) })
  app.mount(root)
  cleanups.push(() => app.unmount())
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('ERR_EMPTY_RESPONSE')
  expect(root.textContent).toContain('刷新')
  expect(root.textContent).not.toContain('secret')
  state.value = { ...state.value, error: { code: 'BROWSER_CERTIFICATE_ERROR', message: 'certificate failed' } }
  await nextTick()
  expect(root.textContent).toContain('安全证书验证失败')
  expect(root.textContent).not.toContain('继续访问')
  initializationFailed.value = true
  await nextTick()
  expect(root.textContent).toContain('无法打开浏览器')
  expect(root.textContent).not.toContain('BROWSER_CERTIFICATE_ERROR')
})
