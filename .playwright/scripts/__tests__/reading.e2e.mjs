import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

function pane(page, title) {
  return page.locator('.workbench-pane').filter({ has: page.locator('.workbench-pane-title', { hasText: title }) })
}

function scrollport(owner) {
  return owner.locator('[data-chat-scroll-viewport]')
}

async function anchor(owner) {
  return scrollport(owner).evaluate((element) => {
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll('[data-chat-row-key]')].find(row => row.getBoundingClientRect().bottom > top)
    return row ? { key: row.dataset.chatRowKey, offset: row.getBoundingClientRect().top - top } : null
  })
}

async function settleScroll(owner) {
  await scrollport(owner).evaluate(element => new Promise((resolve, reject) => {
    let previous = ''
    let steadyFrames = 0
    const deadline = performance.now() + 10000
    const sample = () => {
      const current = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`
      steadyFrames = current === previous ? steadyFrames + 1 : 0
      previous = current
      if (steadyFrames >= 4)
        resolve()
      else if (performance.now() > deadline)
        reject(new Error('Reading viewport did not settle'))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
}

test('reading retains history anchors, outline navigation and independent streaming panes', async ({ buddy }) => {
  test.setTimeout(180000)
  let stream
  const finished = Promise.withResolvers()
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    await once(request, 'end')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: 'reading-stream', model: 'reading-fixture', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
    stream = text => send({ content: text })
    send({ role: 'assistant', content: 'Streaming start.\n\n' })
    await finished.promise
    send({}, 'stop')
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const instance = await buddy.createInstance('reading')
  try {
    const desktop = await instance.launch()
    const { page, app } = desktop
    await useSyntheticCredentialStorage(desktop)
    await page.evaluate(async (baseUrl) => {
      const api = window.lexoraDesktop.localChat.providers
      await api.upsertCustom({ id: 'reading-fixture', displayName: 'Reading fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'reading-fixture', name: 'Reading fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 4096 }] })
      const stop = api.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'reading-fixture' && challenge.type === 'secret')
          void api.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await api.login('reading-fixture', 'api_key')
      }
      finally { stop() }
      await api.setDefaultModel({ providerId: 'reading-fixture', modelId: 'reading-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await app.evaluate(({ BrowserWindow }, databasePath) => {
      BrowserWindow.getAllWindows()[0].setSize(1800, 1000)
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const db = new DatabaseSync(databasePath)
      try {
        db.exec('BEGIN')
        for (const id of ['a', 'b']) {
          const now = new Date().toISOString()
          db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, `Reading ${id.toUpperCase()}`, `branch-${id}`, now, now)
          db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
          for (let index = 0; index < 120; index++) {
            const content = `History ${id}-${index}\n\n${index % 2 ? '> Nested reading\n> - Keep the current selection\n> - Preserve the scroll anchor\n\n| Key | Value |\n| --- | --- |\n| Item | Result |\n\n```ts\nconst example = "stable"\n```' : 'A question with enough content to retain a useful reading anchor.'}`
            db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${index}`, id, `branch-${id}`, index % 2 ? 'assistant' : 'user', JSON.stringify({ text: content }), new Date(Date.now() - (120 - index) * 1000).toISOString())
          }
        }
        db.exec('COMMIT')
      }
      finally { db.close() }
    }, path.join(instance.home, 'buddy/buddy.sqlite3'))
    await page.reload()
    await page.locator('[data-task-id="a"] .desktop-task-sidebar__task').click()
    const first = pane(page, 'Reading A')
    await expect(first.locator('[data-message-id="a-119"]')).toBeVisible()
    const originalRows = await first.locator('[data-chat-row-key]').count()
    const firstLoaded = await first.locator('[data-message-id]').first().getAttribute('data-message-id')
    await scrollport(first).evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
      element.scrollTop = 0
    })
    await expect.poll(() => first.locator('[data-chat-row-key]').count()).toBeGreaterThan(originalRows)
    await expect(first.locator(`[data-message-id="${firstLoaded}"]`)).toBeInViewport()

    await first.locator('.buddy-chat-outline__indicator-button').first().hover()
    const outline = first.locator('.buddy-chat-outline__item-button')
    await expect(outline.first()).toBeVisible()
    await outline.first().focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect(first.locator('[data-message-id="a-0"]')).toBeInViewport()
    await page.mouse.move(600, 60)
    await scrollport(first).focus()
    await page.keyboard.press('PageDown')
    await expect.poll(async () => (await anchor(first))?.key).not.toBe('message:a-0')
    await settleScroll(first)
    const remembered = await anchor(first)
    await page.locator('[data-task-id="b"] .desktop-task-sidebar__task').click()
    await expect(pane(page, 'Reading B').locator('[data-message-id="b-119"]')).toBeVisible()
    await page.locator('[data-task-id="a"] .desktop-task-sidebar__task').click()
    await expect.poll(() => anchor(first)).toEqual(remembered)

    await first.getByTestId('pane-layout-menu').click()
    await page.locator('.n-dropdown-menu:visible').getByText('向右分屏', { exact: true }).click()
    await page.locator('[data-task-id="b"] .desktop-task-sidebar__task').click()
    const second = pane(page, 'Reading B')
    await expect(second.locator('[data-message-id="b-119"]')).toBeVisible()
    await settleScroll(first)
    const firstAnchor = await anchor(first)
    const editor = second.locator('.desktop-chat-composer__prosemirror')
    await editor.fill('Continue this reading example.')
    await second.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(second).toContainText('Streaming start.')
    for (let index = 0; index < 6; index++) {
      stream(`Paragraph ${index}: ${'Keep reading. '.repeat(24)}\n\n`)
      await expect(second).toContainText(`Paragraph ${index}:`)
    }
    await expect.poll(() => scrollport(second).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(5)
    await scrollport(second).hover()
    await page.mouse.wheel(0, -700)
    await expect(second.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    await settleScroll(second)
    const readingAnchor = await anchor(second)
    await scrollport(first).focus()
    await first.locator('[data-message-id="a-3"]').evaluate((element) => {
      const text = 'History a-3'
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.textContent.includes(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
      const node = walker.nextNode()
      if (!node)
        throw new Error('History text was not rendered')
      const range = document.createRange()
      const start = node.textContent.indexOf(text)
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    stream(`Offscreen continuation.\n\n${'Continue without stealing the reading position.\n\n'.repeat(20)}`)
    await expect(second).toContainText('Offscreen continuation.')
    await expect.poll(() => anchor(second)).toEqual(readingAnchor)
    await expect.poll(() => anchor(first)).toEqual(firstAnchor)
    expect(await page.evaluate(() => window.getSelection().toString())).toBe('History a-3')
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('History a-3')
    await second.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect.poll(() => scrollport(second).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(5)
    finished.resolve()
    await expect(second.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    finished.resolve()
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
