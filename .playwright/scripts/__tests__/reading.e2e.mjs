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

test('final markdown preserves unmatched emphasis and Mermaid frontmatter through theme changes', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('markdown')
  const desktop = await instance.launch()
  const { page, app } = desktop
  const text = 'Literal **unfinished\n\n```mermaid\n---\ntitle: Preserved diagram title\n---\nflowchart LR\n  A[Start] --> B[Done]\n```'
  await page.evaluate(() => window.lexoraDesktop.localChat.conversations.list(1))
  await app.evaluate((_electron, { databasePath, text }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('markdown-task', 'Markdown rendering', 'markdown-branch', now, now)
      db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run('markdown-branch', 'markdown-task', now)
      db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('markdown-answer', 'markdown-task', 'markdown-branch', 'assistant', JSON.stringify({ text }), now)
    }
    finally { db.close() }
  }, { databasePath: path.join(instance.home, 'buddy/buddy.sqlite3'), text })
  await page.reload()
  await page.locator('[data-task-id="markdown-task"] .desktop-task-sidebar__task').click()
  const dismiss = page.getByRole('button', { name: '忽略本次', exact: true })
  if (await dismiss.isVisible())
    await dismiss.click()
  const markdown = page.locator('[data-message-id="markdown-answer"] .buddy-chat-markdown')
  const diagram = markdown.locator('svg[aria-roledescription="flowchart-v2"]')
  await expect(markdown.locator('p').first()).toHaveText('Literal **unfinished')
  await expect(markdown.locator('strong')).toHaveCount(0)
  for (const theme of ['dark', 'light']) {
    await page.evaluate(id => window.lexoraDesktop.settings.update({ desktop: { theme: { id } } }), `lexora.themes.classic-${theme}`)
    await expect(page.locator('html')).toHaveAttribute('data-buddy-theme', theme)
    await expect(diagram).toBeVisible()
    await expect(diagram).toContainText('Preserved diagram title')
    await expect(diagram).toContainText('Start')
    await expect(diagram).toContainText('Done')
    await expect.poll(() => diagram.locator('.node rect').first().evaluate((element) => {
      const style = getComputedStyle(element)
      const color = document.createElement('span').style
      color.color = style.getPropertyValue('--buddy-accent-solid').trim()
      return style.stroke === color.color
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`markdown-${theme}.png`), animations: 'disabled' })
  }
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

async function anchor(owner) {
  return scrollport(owner).evaluate((element) => {
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll('[data-chat-row-key]')].find(row => row.getBoundingClientRect().bottom > top)
    return row ? { key: row.dataset.chatRowKey, offset: row.getBoundingClientRect().top - top } : null
  })
}

async function scrollUpInSmallSteps(page, owner) {
  await scrollport(owner).hover()
  for (let step = 0; step < 3; step++) {
    const previousDistance = await scrollport(owner).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
    await page.mouse.wheel(0, -12)
    await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    await settleScroll(owner)
    expect(await scrollport(owner).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(previousDistance + 5)
    await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  }
}

async function loadedRows(owner) {
  return Number(await owner.locator('[data-transcript-row-count]').getAttribute('data-transcript-row-count'))
}

async function navigateOutline(page, owner, index) {
  await owner.locator('.buddy-chat-outline__indicator-button').first().hover()
  await owner.locator('.buddy-chat-outline__item-button').first().focus()
  await page.keyboard.press('Home')
  await expect(owner.locator('[data-outline-index="0"]')).toBeFocused()
  for (let step = 0; step < index; step++) {
    await page.keyboard.press('ArrowDown')
    await expect(owner.locator(`[data-outline-index="${step + 1}"]`)).toBeFocused()
  }
  await page.keyboard.press('Enter')
  await page.mouse.move(600, 60)
  await settleScroll(owner)
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
    await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
    await expect(page.getByTestId('feature-discovery-reminder')).toHaveCount(0)
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
    await page.evaluate(async () => {
      const api = window.lexoraDesktop.localChat
      const { defaultBuddyId } = await api.buddies.list()
      for (const id of ['a', 'b']) {
        await api.conversations.addMember(id, defaultBuddyId)
        await api.conversations.setBuddy(id, defaultBuddyId)
      }
    })
    await page.reload()
    await page.locator('[data-task-id="a"] .desktop-task-sidebar__task').click()
    const first = pane(page, 'Reading A')
    await expect(first.locator('[data-message-id="a-119"]')).toBeVisible()
    const originalRows = await loadedRows(first)
    const firstLoadedId = `a-${120 - (originalRows - 1)}`
    await scrollport(first).evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
      element.scrollTop = 0
    })
    await expect.poll(() => loadedRows(first)).toBeGreaterThan(originalRows)
    await expect(first.locator(`[data-message-id="${firstLoadedId}"]`)).toBeInViewport()

    await first.locator('.buddy-chat-outline__indicator-button').first().hover()
    const outline = first.locator('.buddy-chat-outline__item-button')
    await expect(outline.first()).toBeVisible()
    await outline.first().focus()
    await page.keyboard.press('Home')
    await expect(first.locator('[data-outline-index="0"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(first.locator('[data-message-id="a-0"]')).toBeInViewport()
    await first.locator('.buddy-chat-outline__indicator-button').first().click()
    await expect(first.locator('[data-message-id="a-0"]')).toBeInViewport()
    await first.locator('.buddy-chat-outline__indicator-button').last().click()
    await expect(first.locator('[data-message-id="a-119"]')).toBeInViewport()
    await scrollUpInSmallSteps(page, first)
    await first.getByRole('button', { name: '回到最新', exact: true }).click()
    await settleScroll(first)
    await scrollport(first).focus()
    await page.keyboard.press('ArrowUp')
    await expect(first.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    await settleScroll(first)
    expect(await scrollport(first).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(5)
    await navigateOutline(page, first, 0)
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
    await page.locator('.n-dropdown-menu:visible').getByText('分屏', { exact: true }).hover()
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
    stream('说明**「A」**。和**「B')
    await expect(second.locator('.buddy-chat-markdown strong').filter({ hasText: '「A」' })).toHaveCount(1)
    stream('」**。\n\n')
    await expect(second.locator('.buddy-chat-markdown strong')).toHaveText(['「A」', '「B」'])
    for (let index = 0; index < 6; index++) {
      stream(`Paragraph ${index}: ${'Keep reading. '.repeat(24)}\n\n`)
      await expect(second).toContainText(`Paragraph ${index}:`)
    }
    await settleScroll(second)
    await expect.poll(() => scrollport(second).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(5)
    await scrollUpInSmallSteps(page, second)
    const nearTailAnchor = await anchor(second)
    stream('Near-tail continuation must not move the reader.\n\n')
    await expect(second).toContainText('Near-tail continuation must not move the reader.')
    await settleScroll(second)
    expect(await anchor(second)).toEqual(nearTailAnchor)
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
    await expect(second.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    await expect.poll(() => anchor(second)).toEqual(readingAnchor)
    await expect.poll(() => anchor(first)).toEqual(firstAnchor)
    expect(await page.evaluate(() => window.getSelection().toString())).toBe('History a-3')
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('History a-3')
    await second.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(second).toContainText('Offscreen continuation.')
    await expect.poll(() => scrollport(second).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(5)
    finished.resolve()
    await expect(second.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    await expect(second.locator('.buddy-chat-markdown strong')).toHaveText(['「A」', '「B」'])
    expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    finished.resolve()
    await instance.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('resizing long transcripts preserves reading anchors, expanded messages and tail following', async ({ buddy }, testInfo) => {
  test.setTimeout(180000)
  const instance = await buddy.createInstance('reading-resize')
  const { app, page, diagnostics } = await instance.launch()
  await page.evaluate(() => window.lexoraDesktop.localChat.conversations.list(1))
  await app.evaluate(({ BrowserWindow }, databasePath) => {
    BrowserWindow.getAllWindows()[0].setSize(1800, 1000)
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      db.exec('BEGIN')
      const message = db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      for (const id of ['resize-a', 'resize-b']) {
        const now = new Date().toISOString()
        db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id, `branch-${id}`, now, now)
        db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
        for (let index = 0; index < 120; index++) {
          const text = index % 2
            ? `Response ${index}\n\n${'A paragraph with **formatted text** and a stable reading position. '.repeat(18)}\n\n- First result\n- Second result\n\n| Key | Value |\n| --- | --- |\n| Result | Preserved |`
            : `Question ${index}\n\n${'A long user message that must keep its full original content when resized. '.repeat(12)}`
          message.run(`${id}-${index}`, id, `branch-${id}`, index % 2 ? 'assistant' : 'user', JSON.stringify({ text }), new Date(Date.now() - (120 - index) * 1000).toISOString())
        }
      }
      db.exec('COMMIT')
    }
    finally { db.close() }
  }, path.join(instance.home, 'buddy/buddy.sqlite3'))
  await page.reload()
  await page.locator('[data-task-id="resize-a"] .desktop-task-sidebar__task').click()
  const first = pane(page, 'resize-a')
  await expect(first.locator('[data-message-id="resize-a-119"]')).toBeVisible()
  await first.getByTestId('pane-layout-menu').click()
  await page.locator('.n-dropdown-menu:visible').getByText('分屏', { exact: true }).hover()
  await page.locator('.n-dropdown-menu:visible').getByText('向右分屏', { exact: true }).click()
  await page.locator('[data-task-id="resize-b"] .desktop-task-sidebar__task').click()
  const second = pane(page, 'resize-b')
  await expect(second.locator('[data-message-id="resize-b-119"]')).toBeVisible()
  for (const owner of [first, second]) {
    for (let attempt = 0; await loadedRows(owner) < 121 && attempt < 10; attempt++) {
      const previous = await loadedRows(owner)
      await scrollport(owner).evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
        element.scrollTop = 0
      })
      await expect.poll(() => loadedRows(owner)).toBeGreaterThan(previous)
      await settleScroll(owner)
    }
    expect(await loadedRows(owner)).toBe(121)
    expect(await owner.locator('[data-message-id]').count()).toBeLessThan(30)
  }
  const longMessage = first.locator('[data-message-id="resize-a-60"]')
  await navigateOutline(page, first, 60)
  await expect(longMessage).toBeInViewport()
  const toggle = longMessage.getByRole('button', { name: '展开全文', exact: true })
  await toggle.click()
  const expanded = longMessage.getByRole('button', { name: '收起', exact: true })
  await expect(expanded).toHaveAttribute('aria-expanded', 'true')
  const originalText = await longMessage.locator('.buddy-chat-user-bubble__body').textContent()
  await navigateOutline(page, first, 10)
  await scrollport(first).focus()
  await expect(longMessage).toHaveCount(0)
  await navigateOutline(page, first, 60)
  await expect(expanded).toHaveAttribute('aria-expanded', 'true')
  await scrollport(first).focus()
  await longMessage.locator('.buddy-chat-user-bubble__body').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const selectedText = await page.evaluate(() => window.getSelection().toString())
  await scrollport(first).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = element.scrollHeight
  })
  await expect(first.locator('[data-message-id="resize-a-119"]')).toBeInViewport()
  await expect(longMessage).toHaveCount(1)
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(selectedText)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await expect(longMessage).toHaveCount(0)
  await navigateOutline(page, first, 60)
  await expect(expanded).toHaveAttribute('aria-expanded', 'true')
  await scrollport(first).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    element.scrollTop = element.querySelector('[data-message-id="resize-a-60"]').getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
  })
  await second.getByRole('button', { name: '回到最新', exact: true }).click()
  await settleScroll(first)
  await settleScroll(second)
  const remembered = await anchor(first)
  const divider = page.locator('.workbench-split.horizontal > .workbench-split__handle')
  const bounds = await divider.boundingBox()
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const samples = []
  try {
    for (let trial = 0; trial < 3; trial++) {
      const before = (await session.send('Performance.getMetrics')).metrics
      const started = performance.now()
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 220, start.y, { steps: 12 })
      await page.mouse.move(start.x - 180, start.y, { steps: 18 })
      await page.mouse.move(start.x, start.y, { steps: 10 })
      await page.mouse.up()
      await settleScroll(first)
      await settleScroll(second)
      const after = (await session.send('Performance.getMetrics')).metrics
      const names = ['LayoutCount', 'LayoutDuration', 'RecalcStyleCount', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration']
      samples.push({ elapsedMs: performance.now() - started, ...Object.fromEntries(names.map(name => [name, after.find(item => item.name === name).value - before.find(item => item.name === name).value])) })
      await expect(expanded).toHaveAttribute('aria-expanded', 'true')
      await expect(longMessage.locator('.buddy-chat-user-bubble__body')).toHaveText(originalText)
      await expect.poll(() => anchor(first)).toEqual(remembered)
      await expect.poll(() => scrollport(second).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(5)
    }
  }
  finally {
    await testInfo.attach('resize-performance', { body: JSON.stringify({ messagesPerPane: 120, samples }, null, 2), contentType: 'application/json' })
    await session.detach()
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 120, start.y, { steps: 8 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect.poll(async () => (await divider.boundingBox()).x).toBeCloseTo(bounds.x, 0)
  await expect.poll(() => anchor(first)).toEqual(remembered)
  await expanded.click()
  await expect(longMessage.getByRole('button', { name: '展开全文', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await scrollport(first).focus()
  await scrollport(first).evaluate((element) => {
    window.getSelection().selectAllChildren(element.querySelector('[data-transcript-row-count]'))
  })
  await expect(first.locator('[data-message-id]')).toHaveCount(120)
  await settleScroll(first)
  const allText = await page.evaluate(() => window.getSelection().toString())
  expect(allText).toContain('Question 0')
  expect(allText).toContain('Response 119')
  await scrollport(first).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = element.scrollHeight
  })
  await expect(first.locator('[data-message-id="resize-a-119"]')).toBeInViewport()
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(allText)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await expect.poll(() => first.locator('[data-message-id]').count()).toBeLessThan(30)
  await testInfo.attach('resized-transcripts', { body: await page.screenshot(), contentType: 'image/png' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})
