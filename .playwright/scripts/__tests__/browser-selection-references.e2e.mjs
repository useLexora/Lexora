import { createServer } from 'node:http'
import { expect, test } from '../fixtures/electron.mjs'

test('browser button picks a typed element without clicking the page, cancels safely and retains the latest draft', async ({ buddy }) => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Element reference fixture</title><style>body{margin:24px;font:16px sans-serif}a,button{display:block;width:180px;padding:20px;margin-bottom:16px}</style><a id="target" href="/clicked" onclick="window.clicked=(window.clicked||0)+1">Frozen link excerpt</a><form onsubmit="window.submitted=true;return false"><button>Submit safely</button></form><input type="password" value="must-not-capture"><p id="large">Short text</p>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    const instance = await buddy.createInstance('browser-selection')
    const { app, page, diagnostics } = await instance.launch()
    const input = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
    await expect(input).toBeVisible()
    await input.fill('Keep my latest question.')
    await page.keyboard.press('Control+Shift+P')
    await page.getByPlaceholder('输入命令名称').fill('浏览器')
    await page.getByPlaceholder('输入命令名称').press('Enter')
    const address = page.getByTestId('browser-address')
    await expect(address).toBeVisible()
    await address.fill(url)
    await address.press('Enter')
    const pick = page.getByTestId('browser-pick-element')
    await expect(pick).toBeEnabled()
    const cards = page.locator('.desktop-chat-composer-wrap .resource-quote-card')
    async function nativePoint(selector, click = true) {
      return app.evaluate(async ({ webContents }, { url, selector, click }) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
        if (!guest)
          throw new Error('Fixture guest missing')
        const rect = await guest.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2, width:innerWidth, height:innerHeight }; })()`)
        const point = { x: Math.round(rect.x * guest.getZoomFactor()), y: Math.round(rect.y * guest.getZoomFactor()) }
        guest.sendInputEvent({ type: 'mouseMove', ...point })
        if (click) {
          guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
          guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        }
        return { x: point.x / guest.getZoomFactor() / rect.width, y: point.y / guest.getZoomFactor() / rect.height }
      }, { url, selector, click })
    }
    async function waitPicker() {
      await expect(pick).toHaveAttribute('aria-pressed', 'true')
    }
    await pick.click()
    await waitPicker()
    await nativePoint('#target')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('Frozen link excerpt')
    await expect(input).toContainText('Keep my latest question.')
    await expect(address).toHaveValue(url)
    expect(await app.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url).executeJavaScript('Boolean(window.clicked)'), url)).toBe(false)
    await cards.first().locator('.chat-reference-card__link').click()
    await expect(page.locator('.resource-quote-preview:visible')).toContainText('Frozen link excerpt')
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    await expect(address).toHaveValue(url)
    await page.keyboard.press('Escape')
    await pick.click()
    await waitPicker()
    await nativePoint('#target')
    await expect(cards).toHaveCount(1)
    await expect(page.getByText('这段内容已在当前输入中引用', { exact: true })).toBeVisible()
    await pick.click()
    await waitPicker()
    await page.keyboard.press('Escape')
    await expect(pick).toHaveAttribute('aria-pressed', 'false')
    await expect(cards).toHaveCount(1)
    await page.evaluate(async () => {
      const [guest] = await window.lexoraDesktop.browser.listGuests()
      await window.lexoraDesktop.browser.setZoomFactor(guest.sessionId, 1.5)
    })
    await pick.click()
    await waitPicker()
    await nativePoint('button')
    await expect(cards).toHaveCount(2)
    expect(await app.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url).executeJavaScript('Boolean(window.submitted)'), url)).toBe(false)
    await page.evaluate(async () => {
      const [guest] = await window.lexoraDesktop.browser.listGuests()
      await window.lexoraDesktop.browser.setZoomFactor(guest.sessionId, 1)
    })
    await pick.click()
    await waitPicker()
    await nativePoint('input')
    await expect(cards).toHaveCount(3)
    await expect(cards.last()).not.toContainText('must-not-capture')
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      await guest.executeJavaScript('document.querySelector("#large").textContent="x".repeat(32769); document.querySelector("#large").style="height:24px;overflow:hidden"')
    }, url)
    await pick.click()
    await waitPicker()
    await nativePoint('#large')
    await expect(pick).toHaveAttribute('aria-pressed', 'false')
    await expect(cards).toHaveCount(3)
    // Let the deliberately generated limit toast finish before testing a menu at the same screen position.
    const limitFeedback = page.locator('.n-message').filter({ hasText: '每条消息最多 16 条引用' })
    await expect(limitFeedback).toBeVisible()
    await expect(limitFeedback).toHaveCount(0)
    await input.click()
    await page.keyboard.press('Control+\\')
    const inputs = page.locator('.desktop-workbench-area__tasks .tiptap:visible')
    await expect(inputs).toHaveCount(2)
    await input.click()
    await expect(pick).toBeVisible()
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      await guest.executeJavaScript('document.querySelector("#target").textContent="New snapshot for one target"')
    }, url)
    await pick.click()
    await waitPicker()
    const anchor = await nativePoint('#target')
    const menu = page.locator('.resource-selection-menu.n-dropdown:visible')
    const surface = page.getByTestId('browser-guest-surface')
    async function checkMenuPosition(point) {
      const viewport = await surface.boundingBox()
      const box = await menu.boundingBox()
      const windowSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      const x = viewport.x + point.x * viewport.width
      const y = viewport.y + point.y * viewport.height
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(windowSize.width + 1)
      expect(box.y + box.height).toBeLessThanOrEqual(windowSize.height + 1)
      if (x + box.width + 8 < windowSize.width) {
        expect(Math.abs(box.x - x)).toBeLessThan(8)
      }
      else {
        expect(box.x).toBeLessThanOrEqual(x + 8)
        expect(box.x + box.width).toBeGreaterThanOrEqual(x - 8)
      }
      expect(Math.min(Math.abs(box.y - y), Math.abs(box.y + box.height - y))).toBeLessThan(16)
    }
    await expect(menu).toBeVisible()
    await checkMenuPosition(anchor)
    await menu.getByRole('menuitem', { name: '引用到其他对话', exact: true }).hover()
    const targets = page.locator('.resource-selection-menu:visible').filter({ has: page.locator('.resource-selection-menu-option__label').filter({ hasText: /^分屏 2/ }) })
    await targets.getByRole('menuitem').filter({ hasText: /^分屏 2/ }).click()
    await expect(page.locator('.resource-quote-card').filter({ hasText: 'New snapshot for one target' })).toHaveCount(1)
    await expect(inputs.first()).toContainText('Keep my latest question.')
    await page.evaluate(async () => {
      const [guest] = await window.lexoraDesktop.browser.listGuests()
      await window.lexoraDesktop.browser.setZoomFactor(guest.sessionId, 1.5)
    })
    await pick.click()
    await waitPicker()
    const zoomAnchor = await nativePoint('#target')
    await expect(menu).toBeVisible()
    await checkMenuPosition(zoomAnchor)
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      await guest.executeJavaScript('document.querySelector("#target").style="position:fixed;bottom:12px;right:12px;width:80px;height:32px;padding:0;margin:0;overflow:hidden"')
    }, url)
    await pick.click()
    await waitPicker()
    const edgeAnchor = await nativePoint('#target')
    await expect(menu).toBeVisible()
    await checkMenuPosition(edgeAnchor)
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(page.locator('.resource-quote-card').filter({ hasText: 'New snapshot for one target' })).toHaveCount(1)
    await pick.click()
    await waitPicker()
    await address.fill(`${url}?next`)
    await address.press('Enter')
    await expect(pick).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.resource-quote-card').filter({ hasText: 'Frozen link excerpt' })).toHaveCount(1)
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally { await new Promise(resolve => server.close(resolve)) }
})

test('native element identity survives scrolling and shadow roots, rejects replacements and cleans up frame highlights', async ({ buddy }) => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><title>Native element identity</title>
      <style>body{margin:32px;font:16px system-ui;min-height:1400px}button{padding:20px;border:0;border-radius:6px}iframe{display:block;width:260px;height:120px;border:0;margin-top:60px}</style>
      <button id="target">Original element</button><div id="shadow" style="margin-top:60px"></div>
      <iframe srcdoc="<button id='frame-button' style='padding:16px;border:0'>Frame element</button>"></iframe>
      <script>const root = document.querySelector('#shadow').attachShadow({mode:'closed'}); root.innerHTML='<button id="shadow-button" style="padding:20px;border:0">Shadow element</button>'; window.shadowButton=root.firstChild;</script>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    const instance = await buddy.createInstance('browser-native-selection')
    const { app, page, diagnostics } = await instance.launch()
    await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible')).toBeVisible()
    await page.keyboard.press('Control+Shift+P')
    await page.getByPlaceholder('输入命令名称').fill('浏览器')
    await page.getByPlaceholder('输入命令名称').press('Enter')
    const address = page.getByTestId('browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(page.getByTestId('browser-pick-element')).toBeEnabled()
    const guestEval = expression => app.evaluate(async ({ webContents }, { url, expression }) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
      return guest.executeJavaScript(expression)
    }, { url, expression })
    await expect.poll(() => guestEval('Boolean(document.querySelector("iframe")?.contentDocument?.querySelector("button"))')).toBe(true)
    async function start() {
      await page.evaluate(async () => {
        const [guest] = await window.lexoraDesktop.browser.listGuests()
        window.selectionRequestId = crypto.randomUUID()
        window.selectionResult = window.lexoraDesktop.browser.pickElement(guest.sessionId, window.selectionRequestId)
      })
    }
    async function point(target, click = false) {
      await app.evaluate(async ({ webContents }, { url, target, click }) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url)
        const point = await guest.executeJavaScript(`(() => {
          const target = ${JSON.stringify(target)};
          const frame = document.querySelector('iframe');
          const element = target === 'shadow' ? window.shadowButton : target === 'frame' ? frame.contentDocument.querySelector('button') : document.querySelector('#target');
          const r = element.getBoundingClientRect(), f = target === 'frame' ? frame.getBoundingClientRect() : { x:0, y:0 };
          return { x: Math.round(r.x+r.width/2+f.x), y: Math.round(r.y+r.height/2+f.y) };
        })()`)
        guest.sendInputEvent({ type: 'mouseMove', ...point })
        if (click) {
          guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
          guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        }
      }, { url, target, click })
    }
    async function pick(target) {
      await start()
      await point(target, true)
      return page.evaluate(() => window.selectionResult)
    }
    const original = await pick('main')
    expect(original).toMatchObject({ status: 'selected', text: 'Original element', element: { attributes: { id: 'target' } } })
    const locate = ({ source, element, text }) => page.evaluate(input => window.lexoraDesktop.browser.locateElement(input), { source, element, text })
    await guestEval('window.scrollTo(0, 400)')
    expect(await locate(original)).toBe(true)
    await expect.poll(() => guestEval('window.scrollY')).toBeLessThan(60)
    await guestEval('document.querySelector("#target").outerHTML = document.querySelector("#target").outerHTML')
    expect(await locate(original)).toBe(false)
    expect(await pick('shadow')).toMatchObject({ status: 'selected', text: 'Shadow element', element: { attributes: { id: 'shadow-button' } } })
    expect(await pick('frame')).toMatchObject({ status: 'selected', text: 'Frame element', element: { attributes: { id: 'frame-button' } } })
    await start()
    await point('frame')
    await expect.poll(() => guestEval('document.querySelector("iframe").contentDocument.querySelectorAll(":popover-open").length')).toBe(1)
    await page.evaluate(async () => {
      const [guest] = await window.lexoraDesktop.browser.listGuests()
      await window.lexoraDesktop.browser.cancelElementPick(guest.sessionId, window.selectionRequestId)
    })
    expect(await page.evaluate(() => window.selectionResult)).toEqual({ status: 'cancelled' })
    expect(await guestEval('document.querySelector("iframe").contentDocument.querySelectorAll(":popover-open").length')).toBe(0)
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally { await new Promise(resolve => server.close(resolve)) }
})
