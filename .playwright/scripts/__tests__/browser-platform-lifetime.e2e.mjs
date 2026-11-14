import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { expect, test } from '../fixtures/electron.mjs'

test('platform browser survives workbench destruction, rejects stale presentation and reattaches the same interactive page', async ({ buddy }, testInfo) => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Background browser fixture</title><style>body{margin:0;background:rgb(210,30,40);font:20px sans-serif}input{margin:20px;height:40px}button{height:40px}</style><input id="text" value="preserved"><button onclick="window.clicks=(window.clicks||0)+1">Count</button><div id="ticks"></div><script>window.ticks=0;setInterval(()=>document.querySelector("#ticks").textContent=String(++window.ticks),20)</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    const instance = await buddy.createInstance('browser-background')
    const { app, page } = await instance.launch()
    const state = await page.evaluate(async (url) => {
      const state = await window.lexoraDesktop.browser.ensureSession(null, 'lifetime-test')
      return window.lexoraDesktop.browser.navigate(state.sessionId, url)
    }, url)
    const pageId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.id, url)
    expect(typeof pageId).toBe('number')
    const bounds = { x: 40, y: 100, width: 620, height: 300 }
    const oldToken = await page.evaluate(() => window.lexoraDesktop.browser.acquirePresentation())
    const presentation = { presentationId: oldToken, sessionId: state.sessionId, pageId: state.pageId, visible: true, bounds, clip: bounds }
    await page.evaluate(input => window.lexoraDesktop.browser.present(input), presentation)
    const initial = await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)
      contents.focus()
      await contents.executeJavaScript('document.querySelector("#text").focus()')
      contents.insertText(' retained')
      return { text: await contents.executeJavaScript('document.querySelector("#text").value'), ticks: await contents.executeJavaScript('window.ticks'), zoom: contents.getZoomFactor(), size: (await contents.capturePage()).getSize() }
    }, pageId)
    expect(initial.text).toContain('retained')
    expect(initial.size.width).toBeGreaterThan(0)
    await page.evaluate(async sessionId => window.lexoraDesktop.browser.setZoomFactor(sessionId, 1.25), state.sessionId)
    await page.evaluate(input => window.lexoraDesktop.browser.present(input), { ...presentation, visible: false })
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('lexora-app:'))
      if (!window)
        throw new Error('Workbench is missing')
      setImmediate(() => window.destroy())
    })
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id)?.debugger.sendCommand('Runtime.evaluate', { expression: 'window.ticks', returnByValue: true }))?.result?.value, pageId)).toBeGreaterThan(initial.ticks + 2)
    const offline = await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)
      await contents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.querySelector("button").click()' })
      const snapshot = await contents.capturePage(undefined, { stayHidden: true })
      return { clicks: await contents.executeJavaScript('window.clicks'), text: await contents.executeJavaScript('document.querySelector("#text").value'), screenshotBytes: snapshot.toPNG().length }
    }, pageId)
    expect(offline).toMatchObject({ clicks: 1, text: initial.text })
    expect(offline.screenshotBytes).toBeGreaterThan(100)
    const newWindow = app.waitForEvent('window')
    await app.evaluate(({ app }) => app.emit('activate'))
    const reopened = await newWindow
    await expect(reopened.locator('.desktop-workbench-area__tasks .tiptap:visible').first()).toBeVisible()
    const stale = await reopened.evaluate(async (input) => {
      try {
        await window.lexoraDesktop.browser.present(input)
        return false
      }
      catch { return true }
    }, presentation)
    expect(stale).toBe(true)
    const guests = await reopened.evaluate(() => window.lexoraDesktop.browser.listGuests())
    expect(guests).toContainEqual(expect.objectContaining({ sessionId: state.sessionId, pageId: state.pageId }))
    const nextToken = await reopened.evaluate(() => window.lexoraDesktop.browser.acquirePresentation())
    await reopened.evaluate(input => window.lexoraDesktop.browser.present(input), { ...presentation, presentationId: nextToken })
    const resumed = await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)
      const button = await contents.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
      const point = { x: Math.round(button.x * contents.getZoomFactor()), y: Math.round(button.y * contents.getZoomFactor()) }
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
      return { id: contents.id, zoom: contents.getZoomFactor(), text: await contents.executeJavaScript('document.querySelector("#text").value') }
    }, pageId)
    expect(resumed).toEqual({ id: pageId, zoom: 1.25, text: initial.text })
    await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.clicks'), pageId)).toBe(2)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().startsWith('lexora-app:')).length)).toBe(1)
    const image = await app.evaluate(async ({ desktopCapturer }) => {
      const [screen] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1500, height: 950 } })
      return screen.thumbnail.toPNG().toString('base64')
    })
    await testInfo.attach('reattached-browser', { body: Buffer.from(image, 'base64'), contentType: 'image/png' })
  }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
