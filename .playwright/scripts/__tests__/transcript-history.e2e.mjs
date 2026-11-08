import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { test as base, expect, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

const messageCount = 420
const contentTolerance = 3

function markdown(label, sections, rich = true) {
  return Array.from({ length: sections }, (_, section) => {
    const marker = `ANCHOR-${label}-S${String(section).padStart(3, '0')}`
    return [
      `## ${label} 第 ${section + 1} 节`,
      `${marker} ${'这是一段合成的长对话内容，用来检查连续阅读时文字是否跟随滚轮移动，而不会因为高度重算突然跳到别处。'.repeat(section % 4 + 2)}`,
      ...(rich
        ? [
            '- 阅读位置应该保持稳定。\n- 内容继续增长不应把读者带走。',
            section % 3 === 0 ? `\`\`\`typescript\n${Array.from({ length: 8 + section % 12 }, (_, index) => `const result${index} = { section: ${section}, text: "stable-content-${index}" }`).join('\n')}\n\`\`\`` : '> 引用中的文字同样不能改变既有内容的位置。',
            section % 4 === 0 ? '| 字段 | 说明 |\n| --- | --- |\n| 阅读 | 保持原位 |\n| 生成 | 持续输出 |' : '',
          ]
        : []),
      `${marker}-END`,
    ].filter(Boolean).join('\n\n')
  }).join('\n\n')
}

function makeHistory(shape, count = messageCount) {
  const id = `history-${shape}`
  return {
    id,
    title: `History ${shape}`,
    messages: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      text: index % 2
        ? markdown(`${shape.toUpperCase()}-R${String((index + 1) / 2).padStart(3, '0')}`, shape === 'long' ? index === count - 1 ? 30 : 6 + index % 5 * 3 : 1, shape === 'long')
        : `第 ${Math.floor(index / 2) + 1} 轮合成问题，请解释并保留详细例子。`,
      createdAt: new Date(Date.UTC(2025, 0, 1 + (shape === 'dates' ? Math.floor(index / 60) : 0), 12, 0, shape === 'dates' ? index % 60 : index)).toISOString(),
    })),
  }
}

function pane(page, title) {
  return page.locator('.workbench-pane').filter({ has: page.locator('.workbench-pane-title', { hasText: title }) })
}

function scrollport(owner) {
  return owner.locator('[data-chat-scroll-viewport]')
}

async function installObservations(page) {
  await page.evaluate(() => {
    function contentAnchor(element, target) {
      const view = element.getBoundingClientRect()
      const occurrences = new Map()
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        const messageId = parent.closest('[data-message-id]')?.dataset.messageId
        if (!messageId || !parent.closest('.buddy-chat-message__body') || parent.closest('button, time'))
          continue
        const text = node.textContent
        const key = `${messageId}:${text}`
        const occurrence = occurrences.get(key) ?? 0
        occurrences.set(key, occurrence + 1)
        if (target && (messageId !== target.messageId || text !== target.text || occurrence !== target.occurrence))
          continue
        if (!target) {
          const bounds = parent.getBoundingClientRect()
          if (bounds.bottom <= view.top || bounds.top >= view.top + view.height * 0.45)
            continue
        }
        const offsets = target ? [target.offset] : [...text.matchAll(/\S{1,16}/gu)].map(match => match.index)
        for (const offset of offsets) {
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + 1)
          const rect = range.getBoundingClientRect()
          const y = rect.top - view.top
          if (rect.height > 0 && (target || (y >= 8 && rect.bottom - view.top < view.height * 0.45))) {
            return { messageId, text, occurrence, offset, y, visible: y >= 0 && rect.bottom <= view.bottom }
          }
        }
      }
      return null
    }

    function scrollbar(element) {
      const style = getComputedStyle(element)
      return {
        overflowing: element.scrollHeight > element.clientHeight + 1,
        gutter: element.offsetWidth - element.clientWidth - element.clientLeft - Number.parseFloat(style.borderRightWidth),
        overflowY: style.overflowY,
        width: style.scrollbarWidth,
        color: style.scrollbarColor,
        thumbFraction: element.clientHeight / element.scrollHeight,
        trackFraction: element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight),
        top: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
      }
    }

    function snapshot(element, target = null) {
      return {
        top: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
        width: element.clientWidth,
        rows: Number(element.querySelector('[data-transcript-row-count]')?.dataset.transcriptRowCount),
        anchor: contentAnchor(element, target),
        detached: Boolean(element.closest('.buddy-chat-transcript-viewport').querySelector('.buddy-chat-return-to-latest')),
        scrollbar: scrollbar(element),
      }
    }

    const state = { snapshot, events: [], samples: [], stop: null, wheelCount: 0, wheelDistance: 0 }
    state.begin = (element, anchor = null) => {
      if (state.stop)
        throw new Error('A transcript observation is already active')
      state.samples = []
      state.wheelCount = 0
      state.wheelDistance = 0
      let frameId
      const wheel = (event) => {
        state.wheelCount++
        state.wheelDistance -= event.deltaY
      }
      element.addEventListener('wheel', wheel, { passive: true })
      function frame() {
        const content = anchor ? contentAnchor(element, anchor) : null
        state.samples.push({
          at: performance.now(),
          mountedRows: element.querySelectorAll('[data-virtual-row-key]').length,
          nodes: element.querySelectorAll('*').length,
          rows: Number(element.querySelector('[data-transcript-row-count]')?.dataset.transcriptRowCount),
          scrollbar: scrollbar(element),
          ...(anchor ? { anchor: content, wheelDistance: state.wheelDistance, drift: content ? content.y - anchor.y - state.wheelDistance : null } : {}),
        })
        frameId = requestAnimationFrame(frame)
      }
      frame()
      state.stop = () => {
        cancelAnimationFrame(frameId)
        element.removeEventListener('wheel', wheel)
        state.stop = null
        return state.samples
      }
    }
    window.__transcriptHistory = state
    window.lexoraDesktop.localChat.chat.onRunEvent((event) => {
      if (event.type.startsWith('message.'))
        state.events.push(JSON.stringify(event))
    })
  })
}

const test = base.extend({
  historyShape: ['short', { option: true }],
  historyMessageCount: [messageCount, { option: true }],
  history: async ({ buddy, historyShape, historyMessageCount }, use, testInfo) => {
    const instance = await buddy.createInstance(`transcript-${historyShape}`)
    const desktop = await instance.launch()
    const { app, page } = desktop
    const histories = [makeHistory(historyShape, historyMessageCount), makeHistory('other', 4)]
    const report = { shape: historyShape, messageCount: historyMessageCount, comparisons: [], geometry: [], unavailableAnchors: [] }
    try {
      await expect(page.locator('.desktop-shell')).toBeVisible()
      await page.evaluate(() => window.lexoraDesktop.localChat.conversations.list(1))
      await app.evaluate(({ BrowserWindow }, { databasePath, histories }) => {
        BrowserWindow.getAllWindows()[0].setSize(1500, 1000)
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
        const db = new DatabaseSync(databasePath)
        try {
          db.exec('BEGIN')
          const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          for (const { id, title, messages } of histories) {
            const now = new Date().toISOString()
            db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, `branch-${id}`, now, now)
            db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
            for (const message of messages)
              insertMessage.run(message.id, id, `branch-${id}`, message.role, JSON.stringify({ text: message.text }), message.createdAt)
          }
          db.exec('COMMIT')
        }
        finally {
          db.close()
        }
      }, { databasePath: path.join(instance.home, 'buddy/buddy.sqlite3'), histories })
      await page.evaluate(async (ids) => {
        const api = window.lexoraDesktop.localChat
        const { defaultBuddyId } = await api.buddies.list()
        for (const id of ids) {
          await api.conversations.addMember(id, defaultBuddyId)
          await api.conversations.setBuddy(id, defaultBuddyId)
        }
      }, histories.map(history => history.id))
      await page.reload()
      await installObservations(page)
      await use({ ...desktop, instance, report, data: histories[0], shape: historyShape })
    }
    finally {
      if (!page.isClosed()) {
        const unfinished = await page.evaluate(() => window.__transcriptHistory?.stop?.()).catch(() => null)
        if (unfinished)
          report.geometry.push({ name: 'interrupted-observation', samples: unfinished })
      }
      await testInfo.attach('transcript-history', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
    }
  },
})

test.setTimeout(180000)

async function snapshot(owner, anchor = null) {
  return scrollport(owner).evaluate((element, target) => window.__transcriptHistory.snapshot(element, target), anchor)
}

async function settle(owner) {
  await scrollport(owner).evaluate(element => new Promise((resolve, reject) => {
    let previous = ''
    let steady = 0
    const deadline = performance.now() + 10000
    function frame() {
      const state = window.__transcriptHistory.snapshot(element)
      const current = JSON.stringify([state.top, state.height, state.viewport, state.width, state.rows, state.scrollbar])
      steady = current === previous ? steady + 1 : 0
      previous = current
      if (steady >= 12)
        resolve()
      else if (performance.now() > deadline)
        reject(new Error('Transcript geometry did not settle'))
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }))
}

async function select(history, shape = history.shape) {
  await history.page.locator(`[data-task-id="history-${shape}"] .desktop-task-sidebar__task`).click()
  const owner = pane(history.page, `History ${shape}`)
  await expect(scrollport(owner)).toBeVisible()
  await expect(owner.locator('[data-transcript-row-count]')).toHaveAttribute('data-transcript-row-count', /^[1-9]\d*$/)
  await settle(owner)
  return owner
}

function requireAnchor(history, name, state) {
  if (!state.anchor?.visible)
    history.report.unavailableAnchors.push({ name, state })
  expect(state.anchor, `${name}: a visible content anchor is required`).not.toBeNull()
  expect(state.anchor.visible, `${name}: the content anchor must be visible`).toBe(true)
  return state.anchor
}

function compare(history, name, before, after, movement = 0) {
  const drift = before.anchor && after.anchor ? after.anchor.y - before.anchor.y - movement : null
  history.report.comparisons.push({ name, movement, drift, before, after })
  const original = requireAnchor(history, `${name}: before`, before)
  const restored = requireAnchor(history, `${name}: after`, after)
  expect(restored.messageId, name).toBe(original.messageId)
  expect([restored.text, restored.occurrence, restored.offset], name).toEqual([original.text, original.occurrence, original.offset])
  expect(Math.abs(drift), `${name}: the same text must retain its viewport coordinate`).toBeLessThan(contentTolerance)
}

async function readerPosition(owner) {
  const before = await snapshot(owner)
  await expect.poll(async () => {
    await scrollport(owner).evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
      element.scrollTop = element.clientHeight + 256
    })
    await settle(owner)
    const after = await snapshot(owner)
    expect(after.rows, 'Staging above the pagination threshold must not load history').toBe(before.rows)
    return Math.abs(after.top - after.viewport - 256)
  }, { message: 'Cold measurements must settle above the pagination threshold' }).toBeLessThan(1)
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
}

async function beginObservation(owner, anchor = null) {
  await scrollport(owner).evaluate((element, target) => window.__transcriptHistory.begin(element, target), anchor)
}

async function endObservation(history, name) {
  const samples = await history.page.evaluate(() => window.__transcriptHistory.stop())
  const intervals = samples.slice(1).map((sample, index) => sample.at - samples[index].at).sort((a, b) => a - b)
  const heightSteps = samples.slice(1).map((sample, index) => Math.abs(sample.scrollbar.height - samples[index].scrollbar.height))
  const summary = {
    name,
    frames: samples.length,
    frameP95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? null,
    maxFrameMs: Math.max(0, ...intervals),
    framesOver50Ms: intervals.filter(interval => interval > 50).length,
    maxMountedRows: Math.max(0, ...samples.map(sample => sample.mountedRows)),
    maxNodes: Math.max(0, ...samples.map(sample => sample.nodes)),
    heightCorrections: heightSteps.filter(delta => delta > 1).length,
    heightTravel: heightSteps.reduce((total, delta) => total + delta, 0),
    maxHeightStep: Math.max(0, ...heightSteps),
    maxTrackFractionStep: Math.max(0, ...samples.slice(1).map((sample, index) => Math.abs(sample.scrollbar.trackFraction - samples[index].scrollbar.trackFraction))),
    overflowingFrames: samples.filter(sample => sample.scrollbar.overflowing).length,
    missingGutters: samples.filter(sample => sample.scrollbar.overflowing && sample.scrollbar.gutter <= 0).length,
    gutterVariation: samples.length ? Math.max(...samples.map(sample => sample.scrollbar.gutter)) - Math.min(...samples.map(sample => sample.scrollbar.gutter)) : null,
    samples,
  }
  history.report.geometry.push(summary)
  return summary
}

function expectScrollbar(summary) {
  expect(summary.frames, `${summary.name}: frame observation must run`).toBeGreaterThan(0)
  expect(summary.overflowingFrames, `${summary.name}: native scrolling must remain available`).toBe(summary.frames)
  expect(summary.missingGutters, `${summary.name}: overflowing content must have a native scrollbar gutter`).toBe(0)
  expect(summary.gutterVariation, `${summary.name}: the native gutter must not change the content width`).toBeLessThan(1)
  expect(summary.samples.every(sample => ['auto', 'scroll'].includes(sample.scrollbar.overflowY))).toBe(true)
}

async function prepend(history, owner, name) {
  await readerPosition(owner)
  const initial = await snapshot(owner)
  await scrollport(owner).hover({ position: { x: 64, y: 120 } })
  await beginObservation(owner)
  let result
  let geometry
  try {
    for (let step = 0; step < 35; step++) {
      const before = await snapshot(owner)
      const anchor = requireAnchor(history, `${name}: wheel ${step}`, before)
      const delta = 120
      expect(before.top, 'Pagination must happen before the scrollport reaches its top').toBeGreaterThan(delta)
      const previousWheels = await history.page.evaluate(() => window.__transcriptHistory.wheelCount)
      await history.page.mouse.wheel(0, -delta)
      await expect.poll(() => history.page.evaluate(() => window.__transcriptHistory.wheelCount)).toBeGreaterThan(previousWheels)
      await settle(owner)
      const after = await snapshot(owner, anchor)
      compare(history, `${name}: wheel ${step}`, before, after, delta)
      if (after.rows > initial.rows) {
        result = { before, after }
        break
      }
    }
  }
  finally {
    geometry = await endObservation(history, name)
  }
  expectScrollbar(geometry)
  expect(result, `${name}: a history page must actually be prepended`).toBeDefined()
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  return result
}

async function restore(history, owner, name, whileAway = async () => {}) {
  const before = await snapshot(owner)
  const anchor = requireAnchor(history, name, before)
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  await select(history, 'other')
  await whileAway()
  owner = await select(history)
  const after = await snapshot(owner, anchor)
  compare(history, name, before, after)
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  return owner
}

async function latest(owner) {
  const button = owner.getByRole('button', { name: '回到最新', exact: true })
  if (await button.isVisible())
    await button.click()
  await settle(owner)
  await expect(button).toHaveCount(0)
  const state = await snapshot(owner)
  expect(state.height - state.viewport - state.top).toBeLessThan(5)
}

for (const shape of ['short', 'long']) {
  test.describe(`${shape} transcript history`, () => {
    test.use({ historyShape: shape })

    test('preserves visible text and native scrollbar gutters through three consecutive prepends', async ({ history }) => {
      const owner = await select(history)
      for (let page = 0; page < 3; page++)
        await prepend(history, owner, `prepend-${page + 1}`)
      expect(history.report.unavailableAnchors).toEqual([])
    })

    test('restores the same content coordinate after switching away from an older page', async ({ history }) => {
      let owner = await select(history)
      const initialHead = messageCount - ((await snapshot(owner)).rows - 1)
      await prepend(history, owner, 'load-older-reading')
      await readerPosition(owner)
      const state = await snapshot(owner)
      const anchor = requireAnchor(history, 'older-page-reading', state)
      expect(Number(anchor.messageId.split('-').at(-1))).toBeLessThan(initialHead)
      owner = await restore(history, owner, 'completed-reader-switch')
      await restore(history, owner, 'completed-reader-switch-repeat')
    })
  })
}

test('native scrollbar dragging and ArrowUp/PageUp preserve explicit reading and tail intent', async ({ history }) => {
  const owner = await select(history)
  await latest(owner)
  const geometry = await scrollport(owner).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const state = window.__transcriptHistory.snapshot(element)
    return {
      ...state.scrollbar,
      x: rect.left + element.clientLeft + element.clientWidth + state.scrollbar.gutter / 2,
      bottom: rect.top + element.clientTop + element.clientHeight,
    }
  })
  history.report.nativeDrag = geometry
  expect(geometry.overflowing).toBe(true)
  expect(geometry.gutter, 'The interaction must target an actual native scrollbar gutter').toBeGreaterThan(0)
  const start = { x: geometry.x, y: geometry.bottom - 6 }
  await history.page.mouse.move(start.x, start.y)
  await history.page.mouse.down()
  try {
    await history.page.mouse.move(start.x, start.y - geometry.viewport * 0.25, { steps: 12 })
    await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    const dragging = await snapshot(owner)
    history.report.nativeDrag.inProgress = dragging
    expect(dragging.top).toBeLessThan(geometry.top - geometry.viewport)
    await settle(owner)
    await history.page.mouse.move(start.x, geometry.bottom - 1, { steps: 12 })
  }
  finally {
    await history.page.mouse.up()
  }
  await settle(owner)
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toHaveCount(0)
  await expect(owner.getByText('ANCHOR-SHORT-R210-S000-END', { exact: true })).toBeInViewport()

  await history.page.mouse.move(start.x, start.y)
  await history.page.mouse.down()
  try {
    await history.page.mouse.move(start.x, start.y - 12, { steps: 4 })
    await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  }
  finally {
    await history.page.mouse.up()
  }
  await settle(owner)
  const reading = await snapshot(owner)
  const anchor = requireAnchor(history, 'native-released-reading', reading)
  await settle(owner)
  compare(history, 'native-released-reading', reading, await snapshot(owner, anchor))
  await restore(history, owner, 'native-released-reader-switch')
  await latest(owner)

  await scrollport(owner).focus()
  await expect(scrollport(owner)).toBeFocused()
  const beforeArrow = await snapshot(owner)
  const arrowAnchor = requireAnchor(history, 'native-arrow-up', beforeArrow)
  await history.page.keyboard.press('ArrowUp')
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  await settle(owner)
  const afterArrow = await snapshot(owner, arrowAnchor)
  const arrowDistance = beforeArrow.top - afterArrow.top
  expect(arrowDistance, 'ArrowUp must move to earlier content').toBeGreaterThan(0)
  compare(history, 'native-arrow-up', beforeArrow, afterArrow, arrowDistance)

  const beforePage = await snapshot(owner)
  const pageAnchor = requireAnchor(history, 'native-page-up: before', beforePage)
  await history.page.keyboard.press('PageUp')
  await settle(owner)
  const afterPage = await snapshot(owner)
  const earlier = requireAnchor(history, 'native-page-up: after', afterPage)
  history.report.comparisons.push({ name: 'native-page-up', before: beforePage, after: afterPage })
  expect(afterPage.top).toBeLessThan(beforePage.top - beforePage.viewport / 2)
  expect(Number(earlier.messageId.split('-').at(-1))).toBeLessThan(Number(pageAnchor.messageId.split('-').at(-1)))
  await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
})

test.describe('dated transcript history', () => {
  test.use({ historyShape: 'dates' })

  test('keeps the content coordinate when prepending moves existing day separators and adds earlier dates', async ({ history }) => {
    const owner = await select(history)
    function suffix(rows) {
      const candidates = []
      for (let index = 0; index < history.data.messages.length; index += 2) {
        const messages = history.data.messages.slice(index)
        const days = new Set(messages.map(message => message.createdAt.slice(0, 10)))
        if (messages.length + days.size === rows)
          candidates.push({ first: messages[0], messages: messages.length, days: days.size })
      }
      expect(candidates, 'The loaded date groups must match a unique fixture suffix').toHaveLength(1)
      return candidates[0]
    }
    const before = suffix((await snapshot(owner)).rows)
    const page = await prepend(history, owner, 'date-boundary-prepend')
    const after = suffix(page.after.rows)
    expect(after.messages).toBeGreaterThan(before.messages)
    expect(after.days).toBeGreaterThan(before.days)
    const originalHeadIndex = history.data.messages.findIndex(message => message.id === before.first.id)
    expect(history.data.messages[originalHeadIndex - 2].createdAt.slice(0, 10)).toBe(before.first.createdAt.slice(0, 10))
    history.report.dateGroups = { before, after }
  })
})

async function localStream() {
  let response
  const server = createServer(async (request, reply) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      reply.writeHead(404).end()
      return
    }
    request.resume()
    await once(request, 'end')
    if (response) {
      reply.writeHead(409).end('Only one synthetic stream is expected')
      return
    }
    response = reply
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    send({ role: 'assistant', content: markdown('STREAM', 24) })
  })
  function send(delta, done = false) {
    if (!response || response.destroyed || response.writableEnded)
      throw new Error('The synthetic streaming response is unavailable')
    response.write(`data: ${JSON.stringify({ id: 'transcript-stream', model: 'transcript-fixture', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason: done ? 'stop' : null }] })}\n\n`)
    if (done)
      response.end('data: [DONE]\n\n')
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    append: (text, done = false) => send({ content: text }, done),
    close: async () => {
      response?.end()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function configureProvider(history, baseUrl) {
  await useSyntheticCredentialStorage(history)
  await history.page.evaluate(async (baseUrl) => {
    const api = window.lexoraDesktop.localChat.providers
    await api.upsertCustom({ id: 'transcript-fixture', displayName: 'Transcript fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'transcript-fixture', name: 'Transcript fixture', input: ['text'], reasoning: false, contextWindow: 1000000, maxTokens: 65536 }] })
    const stop = api.onAuthChallenge((challenge) => {
      if (challenge.providerId === 'transcript-fixture' && challenge.type === 'secret')
        void api.respondToAuth(challenge.challengeId, 'offline-fixture-key')
    })
    try {
      await api.login('transcript-fixture', 'api_key')
    }
    finally {
      stop()
    }
    await api.setDefaultModel({ providerId: 'transcript-fixture', modelId: 'transcript-fixture', reasoning: null })
  }, baseUrl)
}

async function waitForChunk(history, marker) {
  await expect.poll(() => history.page.evaluate(marker => window.__transcriptHistory.events.some(event => event.includes(marker)), marker), { timeout: 15000 }).toBe(true)
}

test.describe('long transcript reading', () => {
  test.use({ historyShape: 'long' })

  test('retains detached reading through streaming task switches, continuous upward wheels and completion', async ({ history }) => {
    const stream = await localStream()
    try {
      await configureProvider(history, stream.baseUrl)
      let owner = await select(history)
      await owner.locator('.desktop-chat-composer__prosemirror').fill('请继续合成长篇说明。')
      await owner.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(owner).toContainText('ANCHOR-STREAM-S023-END', { timeout: 45000 })
      await expect(owner.getByRole('button', { name: '停止运行', exact: true })).toBeVisible()
      await latest(owner)
      await scrollport(owner).hover({ position: { x: 64, y: 120 } })
      const before = await snapshot(owner)
      const anchor = requireAnchor(history, 'streaming-wheel-race', before)
      await beginObservation(owner, anchor)
      try {
        for (let step = 0; step < 24; step++) {
          const marker = `ANCHOR-RACE-${step}`
          stream.append(`\n\n${marker} ${'持续生成与上滚同时进行。'.repeat(12)}\n\n`)
          await history.page.mouse.wheel(0, -12)
          await expect.poll(() => history.page.evaluate(() => window.__transcriptHistory.wheelCount)).toBe(step + 1)
          await waitForChunk(history, marker)
        }
        await settle(owner)
        const after = await snapshot(owner, anchor)
        compare(history, 'streaming-wheel-race', before, after, 24 * 12)
        await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
      }
      finally {
        const geometry = await endObservation(history, 'streaming-wheel-race')
        expect(geometry.samples.filter(sample => sample.drift === null), 'Every frame must retain the observed text').toEqual([])
        expect(Math.max(0, ...geometry.samples.map(sample => Math.abs(sample.drift ?? 0))), 'Streaming must not counteract continuous upward input').toBeLessThan(48)
      }
      owner = await restore(history, owner, 'streaming-reader-switch-idle')
      owner = await restore(history, owner, 'streaming-reader-switch-growing', async () => {
        stream.append(`\n\n${markdown('AWAY', 2)}\n\n`)
        await waitForChunk(history, 'ANCHOR-AWAY-S001-END')
      })
      const reading = await snapshot(owner)
      const finalAnchor = requireAnchor(history, 'streaming-completion', reading)
      stream.append('\n\nANCHOR-FINAL-END', true)
      await expect(owner.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0, { timeout: 45000 })
      await settle(owner)
      compare(history, 'streaming-completion', reading, await snapshot(owner, finalAnchor))
      await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
      await latest(owner)
      await expect(owner.getByText('ANCHOR-FINAL-END', { exact: true })).toBeInViewport()
    }
    finally {
      await stream.close()
    }
  })

  test('restores detached reading after streaming completes in another task without replaying the old anchor', async ({ history }) => {
    const stream = await localStream()
    try {
      await configureProvider(history, stream.baseUrl)
      let owner = await select(history)
      await owner.locator('.desktop-chat-composer__prosemirror').fill('请生成用于后台完成恢复验收的长篇说明。')
      await owner.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(owner).toContainText('ANCHOR-STREAM-S023-END', { timeout: 45000 })
      await expect(owner.getByRole('button', { name: '停止运行', exact: true })).toBeVisible()
      await latest(owner)
      await scrollport(owner).hover({ position: { x: 64, y: 120 } })
      await history.page.mouse.wheel(0, -240)
      await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
      await settle(owner)
      const reading = await snapshot(owner)
      const anchor = requireAnchor(history, 'background-completion-reading', reading)
      await expect(owner.locator(`[data-message-id="${anchor.messageId}"]`)).toContainText('ANCHOR-STREAM-S023-END')
      const running = await history.page.evaluate(async (conversationId) => {
        const runs = await window.lexoraDesktop.localChat.runs.list({ conversationId, limit: 10 })
        return runs.filter(run => run.status === 'running')
      }, history.data.id)
      expect(running, 'The synthetic stream must have one active run before switching tasks').toHaveLength(1)
      owner = await restore(history, owner, 'stream-completed-while-away', async () => {
        stream.append('\n\nANCHOR-AWAY-FINAL-END', true)
        await expect.poll(async () => {
          const run = await history.page.evaluate(runId => window.lexoraDesktop.localChat.runs.get(runId), running[0].id)
          history.report.backgroundCompletion = { runId: run.id, status: run.status }
          return run.status
        }, { timeout: 45000 }).toBe('completed')
        await expect(scrollport(pane(history.page, 'History other'))).toBeVisible()
      })
      await expect(owner.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0)
      const restored = await snapshot(owner)
      const restoredAnchor = requireAnchor(history, 'completed-new-reading-position', restored)
      await scrollport(owner).hover({ position: { x: 64, y: 120 } })
      await history.page.mouse.wheel(0, -120)
      await expect.poll(async () => (await snapshot(owner)).top).toBeLessThan(restored.top)
      await settle(owner)
      compare(history, 'completed-new-reading-position', restored, await snapshot(owner, restoredAnchor), 120)
      owner = await restore(history, owner, 'completed-new-position-switch')
      await expect(owner.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0)
    }
    finally {
      await stream.close()
    }
  })

  test('keeps text fixed when completion adds an identity header at the exact row start', async ({ history }) => {
    const stream = await localStream()
    try {
      await configureProvider(history, stream.baseUrl)
      const owner = await select(history)
      await owner.locator('.desktop-chat-composer__prosemirror').fill('请生成用于行首阅读验收的长篇说明。')
      await owner.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(owner).toContainText('ANCHOR-STREAM-S023-END', { timeout: 45000 })
      await latest(owner)
      const initial = requireAnchor(history, 'row-start-source', await snapshot(owner))
      await scrollport(owner).evaluate((element, messageId) => {
        const row = element.querySelector(`[data-message-id="${messageId}"]`)?.closest('[data-virtual-row-key]')
        if (!row)
          throw new Error('The streamed message row must be mounted')
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
        element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top
      }, initial.messageId)
      await settle(owner)
      const before = await snapshot(owner)
      const anchor = requireAnchor(history, 'row-start-completion', before)
      const rowY = await owner.locator(`[data-message-id="${initial.messageId}"]`).evaluate((message) => {
        const row = message.closest('[data-virtual-row-key]')
        const viewport = message.closest('[data-chat-scroll-viewport]')
        return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      })
      expect(Math.abs(rowY)).toBeLessThan(1)
      stream.append('\n\nANCHOR-ROW-START-FINAL-END', true)
      await expect(owner.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0, { timeout: 45000 })
      await settle(owner)
      compare(history, 'row-start-completion', before, await snapshot(owner, anchor))
      await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    }
    finally {
      await stream.close()
    }
  })

  test('restores a reachable reading position when a completed long reply becomes shorter in a wider window', async ({ history }) => {
    let owner = await select(history)
    await history.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 1000))
    await latest(owner)
    await scrollport(owner).evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      element.scrollTop -= 120
    })
    await settle(owner)
    const before = await snapshot(owner)
    requireAnchor(history, 'deep-narrow-reading', before)
    await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    const messageId = `history-long-${messageCount - 1}`
    const oldHeight = await owner.locator(`[data-message-id="${messageId}"]`).evaluate(element => element.getBoundingClientRect().height)
    await select(history, 'other')
    await history.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    owner = await select(history)
    const message = owner.locator(`[data-message-id="${messageId}"]`)
    await expect(message).toBeInViewport()
    const newHeight = await message.evaluate(element => element.getBoundingClientRect().height)
    expect(newHeight).toBeLessThan(oldHeight - before.viewport)
    const after = await snapshot(owner)
    expect(requireAnchor(history, 'deep-wide-reading', after).messageId).toBe(messageId)
    expect(after.top).toBeLessThanOrEqual(after.height - after.viewport)
    await expect(message.getByText('ANCHOR-LONG-R210-S029-END', { exact: true })).toBeInViewport()
    history.report.comparisons.push({ name: 'deep-reading-width-clamp', before, after, oldHeight, newHeight })
  })

  test('preserves visible content and tail intent through window width and height changes', async ({ history }) => {
    const owner = await select(history)
    const lastMessage = owner.locator(`[data-message-id="history-long-${messageCount - 1}"]`)
    await expect(lastMessage).toBeVisible()
    await scrollport(owner).evaluate((element, messageId) => {
      const heading = element.querySelector(`[data-message-id="${messageId}"] h2`)
      if (!heading)
        throw new Error('The final Markdown heading is not mounted')
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
      element.scrollTop += heading.getBoundingClientRect().top - element.getBoundingClientRect().top - 80
    }, `history-long-${messageCount - 1}`)
    await settle(owner)
    async function bodyLayout() {
      return lastMessage.evaluate((message) => {
        const body = message.querySelector('.buddy-chat-message__body')
        const paragraph = body?.querySelector('p')
        const viewport = message.closest('[data-chat-scroll-viewport]')
        if (!body || !paragraph || !viewport)
          throw new Error('The target Markdown paragraph and scrollport must be mounted')
        const lines = new Set()
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0)
              lines.add(Math.round(rect.top))
          }
        }
        const bodyRect = body.getBoundingClientRect()
        const paragraphRect = paragraph.getBoundingClientRect()
        return {
          messageId: message.dataset.messageId,
          bodyWidth: bodyRect.width,
          bodyHeight: bodyRect.height,
          bodyY: bodyRect.top - viewport.getBoundingClientRect().top,
          paragraphText: paragraph.textContent,
          paragraphWidth: paragraphRect.width,
          paragraphHeight: paragraphRect.height,
          paragraphLines: lines.size,
        }
      })
    }
    const before = await snapshot(owner)
    const anchor = requireAnchor(history, 'resize-reading', before)
    const initialLayout = await bodyLayout()
    expect(initialLayout.paragraphLines).toBeGreaterThan(0)
    let previous = before
    let previousLayout = initialLayout
    await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    for (const [width, height] of [[1500, 760], [980, 760], [980, 1000], [1500, 1000]]) {
      await history.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      await settle(owner)
      const after = await snapshot(owner)
      const layout = await bodyLayout()
      history.report.comparisons.push({ name: `body-reflow-${width}-${height}`, before: previousLayout, after: layout, state: after })
      const currentAnchor = requireAnchor(history, `reader-resize-${width}-${height}`, after)
      expect(currentAnchor.messageId).toBe(`history-long-${messageCount - 1}`)
      await expect(lastMessage).toBeInViewport()
      await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
      expect(after.height - after.viewport - after.top, 'Resizing while reading must not jump to the tail').toBeGreaterThan(after.viewport)
      expect(layout.paragraphText).toBe(initialLayout.paragraphText)
      if (Math.abs(after.width - previous.width) < 1) {
        compare(history, `reader-height-resize-${width}-${height}`, previous, await snapshot(owner, previous.anchor))
        expect(Math.abs(layout.paragraphWidth - previousLayout.paragraphWidth)).toBeLessThan(1)
        expect(layout.paragraphLines).toBe(previousLayout.paragraphLines)
        expect(Math.abs(after.viewport - previous.viewport)).toBeGreaterThan(100)
      }
      else if (width === 980) {
        expect(layout.paragraphWidth).toBeLessThan(previousLayout.paragraphWidth - 100)
        expect(layout.paragraphLines, 'The narrower window must actually reflow the same paragraph').toBeGreaterThan(previousLayout.paragraphLines)
        expect(layout.bodyHeight).toBeGreaterThan(previousLayout.bodyHeight)
      }
      else {
        expect(layout.paragraphWidth).toBeGreaterThan(previousLayout.paragraphWidth + 100)
        expect(layout.paragraphLines).toBe(initialLayout.paragraphLines)
      }
      previous = after
      previousLayout = layout
    }
    compare(history, 'reader-width-round-trip', before, await snapshot(owner, anchor))
    await latest(owner)
    for (const [width, height] of [[980, 760], [1500, 1000]]) {
      await history.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      await settle(owner)
      await expect(owner.getByRole('button', { name: '回到最新', exact: true })).toHaveCount(0)
      await expect(lastMessage.getByText('ANCHOR-LONG-R210-S029-END', { exact: true })).toBeInViewport()
      const state = await snapshot(owner)
      history.report.comparisons.push({ name: `tail-resize-${width}-${height}`, state })
      expect(state.height - state.viewport - state.top).toBeLessThan(5)
    }
  })
})
