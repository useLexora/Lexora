import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

const taskCount = 10_000
const taskId = index => `history-${String(index).padStart(5, '0')}`
const searchTitle = '历史深处的唯一检索目标'
const viewportSelector = '.desktop-task-history-list .v-vl'

async function settleLayout(viewport) {
  await viewport.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function collectTaskIds(viewports) {
  const ids = new Set()
  for (const viewport of await viewports.all()) {
    if (!await viewport.isVisible())
      continue
    const budget = await viewport.evaluate((element) => {
      element.scrollTop = 0
      return Math.ceil(element.scrollHeight / Math.max(1, element.clientHeight * 0.75)) + 2
    })
    for (let step = 0; step < Math.min(budget, 1000); step++) {
      await settleLayout(viewport)
      const state = await viewport.evaluate((element) => {
        const ids = [...element.querySelectorAll('[data-task-id]')].map(row => row.dataset.taskId)
        const bottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
        if (!bottom)
          element.scrollTop += element.clientHeight * 0.75
        return { ids, bottom }
      })
      state.ids.forEach(id => ids.add(id))
      if (state.bottom)
        break
      if (step + 1 >= Math.min(budget, 1000))
        throw new Error('History traversal exceeded the bounded visible-page budget')
    }
  }
  return [...ids].sort()
}

async function revealRow(viewport, key) {
  const row = viewport.locator(`[data-row-key="${key}"]`)
  await viewport.evaluate((element, last) => element.scrollTop = last ? element.scrollHeight : 0, key.startsWith('more:'))
  for (let step = 0; step < 40; step++) {
    await settleLayout(viewport)
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded()
      await settleLayout(viewport)
      return row
    }
    const bottom = await viewport.evaluate((element) => {
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1)
        return true
      element.scrollTop += element.clientHeight * 0.75
      return false
    })
    if (bottom)
      break
  }
  throw new Error(`History row not found: ${key}`)
}

test('10,000-task history pages ordinary tasks without hiding attention, searches old tasks and bounds virtual mounts', async ({ buddy }, testInfo) => {
  test.setTimeout(180_000)
  const instance = await buddy.createInstance('task-history')
  const { app, page, diagnostics } = await instance.launch()
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 45000 }).toBe('ready')
  const browserWindow = await app.browserWindow(page)
  await browserWindow.evaluate(window => window.setSize(1280, 800))
  const sections = ['pinned', 'spaces', 'tasks']
  const assertHeadersVisible = async (pinned = true) => {
    const headers = page.locator('.desktop-task-sidebar__section-heading')
    await expect(headers).toHaveText(pinned ? ['置顶', '空间', '任务'] : ['空间', '任务'])
    for (const header of await headers.all())
      await expect(header).toBeInViewport({ ratio: 1 })
  }
  await assertHeadersVisible(false)
  const { spaceIds, markId } = await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    const spaces = []
    for (const name of ['历史验收甲', '历史验收乙'])
      spaces.push(await api.spaces.create({ name, memoryScope: 'space_only', primaryDirectory: null }))
    const mark = await api.taskMarks.create({ name: '历史关注', description: '合成验收标记', color: '#3979d6' })
    return { spaceIds: spaces.map(space => space.id), markId: mark.id }
  })
  const markedIndexes = [9993, 9997, 9998]
  const unreadIndexes = [9990, 9994, 9995]
  const pinnedId = taskId(9996)
  const seed = await app.evaluate(({ app }, input) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('History seeding requires an isolated test profile')
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(input.databasePath)
    const startedAt = performance.now()
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
      const insertTask = db.prepare('INSERT INTO conversations (id, title, space_id, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      const insertBranch = db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)')
      const insertAttention = db.prepare('INSERT INTO task_attention (conversation_id, mark_id, forced_unread) VALUES (?, ?, ?)')
      for (let index = 0; index < input.taskCount; index++) {
        const id = `history-${String(index).padStart(5, '0')}`
        const timestamp = new Date(Date.UTC(2025, 0, 1) - index * 3_600_000).toISOString()
        const spaceId = index % 3 === 0 ? null : input.spaceIds[index % 3 - 1]
        const title = index === 9999 ? input.searchTitle : `合成历史任务 ${String(index).padStart(5, '0')}`
        insertTask.run(id, title, spaceId, `branch-${id}`, timestamp, timestamp)
        insertBranch.run(`branch-${id}`, id, timestamp)
        if (input.markedIndexes.includes(index) || input.unreadIndexes.includes(index))
          insertAttention.run(id, input.markedIndexes.includes(index) ? input.markId : null, Number(input.unreadIndexes.includes(index)))
      }
      db.exec('COMMIT')
      return { count: Number(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count), elapsedMs: performance.now() - startedAt }
    }
    finally { db.close() }
  }, { databasePath: path.join(instance.home, 'buddy/buddy.sqlite3'), taskCount, spaceIds, markId, markedIndexes, unreadIndexes, searchTitle })
  expect(seed.count).toBe(taskCount)
  await page.evaluate(({ pinnedId, spaceId }) => window.lexoraDesktop.settings.update({
    desktop: {
      taskSidebarPinnedItems: [{ id: pinnedId, kind: 'conversation' }, { id: spaceId, kind: 'space' }],
      taskSidebar: { collapsed: false, collapsedSections: [], collapsedSpaces: [] },
    },
  }), { pinnedId, spaceId: spaceIds[0] })

  await app.evaluate(({ ipcMain }) => {
    const probe = globalThis.taskHistoryProbe = { calls: [] }
    const channel = 'lexora:buddy:conversations:list-history'
    const handler = ipcMain._invokeHandlers.get(channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input) => {
      const call = { input, elapsedMs: null, ids: [], nextCursor: null }
      probe.calls.push(call)
      const startedAt = performance.now()
      try {
        const result = await handler(event, input)
        call.ids = result.items.map(item => item.conversation.id)
        call.nextCursor = result.nextCursor
        return result
      }
      catch (error) {
        call.error = String(error)
        throw error
      }
      finally { call.elapsedMs = performance.now() - startedAt }
    })
  })
  await page.addInitScript(() => {
    const metrics = window.taskHistoryMetrics = { maxMountedRows: 0, maxMountedTasks: 0 }
    const sample = () => {
      const history = document.querySelector('.desktop-task-sidebar')
      metrics.maxMountedRows = Math.max(metrics.maxMountedRows, history?.querySelectorAll('[data-row-key]').length ?? 0)
      metrics.maxMountedTasks = Math.max(metrics.maxMountedTasks, history?.querySelectorAll('[data-task-id]').length ?? 0)
    }
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(sample).observe(document.body, { childList: true, subtree: true })
      sample()
    }, { once: true })
  })

  const metrics = { taskCount, seed }
  const calls = () => app.evaluate(() => globalThis.taskHistoryProbe.calls)
  const ordinaryCalls = async spaceId => (await calls()).filter(call => call.input.kind === 'ordinary' && call.input.spaceId === spaceId && call.elapsedMs !== null)
  const expectedIds = new Set([...markedIndexes, ...unreadIndexes, 9996].map(taskId))
  const scopes = [null, ...spaceIds]
  const limits = [8, 3, 3]
  try {
    await page.reload()
    const viewport = page.locator(viewportSelector)
    const sectionViewport = section => page.locator(`.desktop-task-sidebar__${section} .v-vl`)
    const scopeViewport = spaceId => sectionViewport(spaceId === null ? 'tasks' : spaceId === spaceIds[0] ? 'pinned' : 'spaces')
    await expect(viewport).toHaveCount(3)
    for (const [scopeIndex, spaceId] of scopes.entries()) {
      const limit = limits[scopeIndex]
      const ids = Array.from({ length: limit }, (_, index) => taskId(index * 3 + scopeIndex))
      await expect.poll(async () => (await ordinaryCalls(spaceId)).at(-1)?.ids).toEqual(ids)
      ids.forEach(id => expectedIds.add(id))
    }
    await expect.poll(async () => (await calls()).some(call => call.input.kind === 'attention' && call.ids.length === 6)).toBe(true)
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].sort())

    const appendPage = async (scopeIndex) => {
      const spaceId = scopes[scopeIndex]
      const viewport = scopeViewport(spaceId)
      const previous = await ordinaryCalls(spaceId)
      const key = spaceId === null ? 'more:global' : `more:space:${spaceId}`
      const row = await revealRow(viewport, key)
      const button = row.locator('.desktop-task-history-list__more')
      await expect(button).toHaveText('展开显示')
      const before = await viewport.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const anchor = [...element.querySelectorAll('[data-row-kind="task"]')].find(row => row.getBoundingClientRect().top >= bounds.top && row.getBoundingClientRect().bottom <= bounds.bottom)
        return { scrollTop: element.scrollTop, key: anchor?.dataset.rowKey, top: anchor?.getBoundingClientRect().top }
      })
      expect(before.key).toBeTruthy()
      await button.click()
      await expect.poll(async () => (await ordinaryCalls(spaceId)).length).toBe(previous.length + 1)
      const latest = (await ordinaryCalls(spaceId)).at(-1)
      expect(latest.error).toBeUndefined()
      expect(latest.input.limit).toBe(10)
      expect(latest.input.cursor).toBe(previous.at(-1).nextCursor)
      const ids = Array.from({ length: 10 }, (_, index) => taskId((limits[scopeIndex] + index) * 3 + scopeIndex))
      expect(latest.ids).toEqual(ids)
      limits[scopeIndex] += 10
      ids.forEach(id => expectedIds.add(id))
      await settleLayout(viewport)
      const after = await viewport.evaluate((element, key) => ({
        scrollTop: element.scrollTop,
        top: element.querySelector(`[data-row-key="${key}"]`)?.getBoundingClientRect().top,
      }), before.key)
      expect(after.top).toBeDefined()
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
    }

    await appendPage(1)
    await appendPage(2)
    for (let pageIndex = 0; pageIndex < 10; pageIndex++)
      await appendPage(0)
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].sort())
    await expect(page.locator('.desktop-task-history-list').getByText(/收起/)).toHaveCount(0)
    const mounted = await page.evaluate(() => window.taskHistoryMetrics)
    expect(mounted.maxMountedRows).toBeLessThanOrEqual(80)
    expect(mounted.maxMountedTasks).toBeLessThan(expectedIds.size)
    await assertHeadersVisible()
    const offsets = await viewport.evaluateAll(elements => elements.map(element => element.scrollTop))
    await sectionViewport('pinned').evaluate(element => element.scrollTop = 0)
    await settleLayout(sectionViewport('pinned'))
    expect(await viewport.evaluateAll(elements => elements.slice(1).map(element => element.scrollTop))).toEqual(offsets.slice(1))
    await assertHeadersVisible()

    expect(expectedIds.has(taskId(9999))).toBe(false)
    await page.locator('.desktop-task-sidebar__search-trigger').click()
    const search = page.locator('.desktop-task-search-dialog')
    await search.locator('input').fill(searchTitle)
    await expect(search.locator('.desktop-task-search-dialog__result').filter({ hasText: searchTitle })).toBeVisible()
    const searchCalls = (await calls()).filter(call => call.input.kind === 'search' && call.input.query === searchTitle)
    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0].ids).toEqual([taskId(9999)])
    await page.keyboard.press('Escape')
    await expect(search).toBeHidden()
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].sort())
    const finalCalls = await calls()
    expect(finalCalls.filter(call => call.error)).toEqual([])

    const spaceRow = await revealRow(scopeViewport(spaceIds[0]), `space:${spaceIds[0]}`)
    const spaceToggle = spaceRow.getByRole('button', { name: '历史验收甲', exact: true })
    await expect(spaceToggle).toBeEnabled()
    await spaceToggle.click()
    await expect(spaceToggle).toHaveAttribute('aria-expanded', 'false')
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].filter(id => Number(id.slice(-5)) % 3 !== 1).sort())
    await revealRow(scopeViewport(spaceIds[0]), `space:${spaceIds[0]}`)
    await spaceToggle.click()
    await expect(spaceToggle).toHaveAttribute('aria-expanded', 'true')
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].sort())

    const taskViewport = sectionViewport('tasks')
    const beforeFold = await taskViewport.evaluate(element => element.scrollTop)
    const globalSection = page.locator('[data-row-key="section:tasks"]')
    const sectionToggle = globalSection.getByRole('button', { name: '任务', exact: true })
    await sectionToggle.click()
    await expect(sectionToggle).toHaveAttribute('aria-expanded', 'false')
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].filter(id => Number(id.slice(-5)) % 3 !== 0 || id === pinnedId).sort())
    await sectionToggle.click()
    await expect(sectionToggle).toHaveAttribute('aria-expanded', 'true')
    await settleLayout(taskViewport)
    expect(Math.abs(await taskViewport.evaluate(element => element.scrollTop) - beforeFold)).toBeLessThanOrEqual(2)
    await assertHeadersVisible()
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].sort())
    const beforeNavigation = await viewport.evaluateAll(elements => elements.map(element => element.scrollTop))
    await page.getByRole('button', { name: '自动化', exact: true }).click()
    await expect(taskViewport).toBeHidden()
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await expect(taskViewport).toBeVisible()
    await settleLayout(taskViewport)
    for (const [index, section] of sections.entries())
      await expect.poll(async () => Math.abs(await sectionViewport(section).evaluate(element => element.scrollTop) - beforeNavigation[index])).toBeLessThanOrEqual(2)
    await assertHeadersVisible()
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds].sort())
    expect((await calls()).filter(call => call.input.kind === 'ordinary').length).toBe(finalCalls.filter(call => call.input.kind === 'ordinary').length)

    await page.locator('.desktop-task-sidebar__search-trigger').click()
    await search.locator('input').fill(searchTitle)
    await search.locator('.desktop-task-search-dialog__result').filter({ hasText: searchTitle }).click()
    await expect(search).toBeHidden()
    await expect(page.locator(`[data-task-id="${taskId(9999)}"].is-active`)).toBeVisible()
    expect(await collectTaskIds(viewport)).toEqual([...expectedIds, taskId(9999)].sort())
    await page.evaluate(({ pinnedId, spaceIds }) => window.lexoraDesktop.settings.update({ desktop: {
      taskSidebarPinnedItems: [{ id: pinnedId, kind: 'conversation' }, ...spaceIds.map(id => ({ id, kind: 'space' }))],
    } }), { pinnedId, spaceIds })
    await expect.poll(() => page.locator('.desktop-task-sidebar__spaces').evaluate(element => element.getBoundingClientRect().height)).toBe(30)
    await assertHeadersVisible()
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    metrics.requests = await calls()
    metrics.renderer = await page.evaluate(() => window.taskHistoryMetrics)
    await testInfo.attach('history-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
  }
})

test('marked tasks beyond the space quota remain visible and empty pins stay hidden', async ({ buddy }) => {
  const markedCount = 7
  const instance = await buddy.createInstance('task-history-quota')
  const { app, page, diagnostics } = await instance.launch()
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.runtime.getStatus()).status), { timeout: 45000 }).toBe('ready')
  const browserWindow = await app.browserWindow(page)
  await browserWindow.evaluate(window => window.setSize(1280, 800))
  const { spaceId, markId } = await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    const space = await api.spaces.create({ name: '标记计数验收', memoryScope: 'space_only', primaryDirectory: null })
    const mark = await api.taskMarks.create({ name: '重要', description: '合成验收标记', color: '#3979d6' })
    return { spaceId: space.id, markId: mark.id }
  })
  await app.evaluate(({ app }, { databasePath, spaceId, markId, markedCount }) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('History seeding requires an isolated test profile')
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
      const insertTask = db.prepare('INSERT INTO conversations (id, title, space_id, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      const insertBranch = db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)')
      const insertMark = db.prepare('INSERT INTO task_attention (conversation_id, mark_id) VALUES (?, ?)')
      for (let index = 0; index < 20; index++) {
        const id = `quota-${index}`
        const marked = index >= 10 && index < 10 + markedCount
        const timestamp = new Date(Date.UTC(2025, 0, 1) - index * 3_600_000).toISOString()
        insertTask.run(id, `${marked ? '标记任务' : '普通任务'} ${index + 1}`, spaceId, `branch-${id}`, timestamp, timestamp)
        insertBranch.run(`branch-${id}`, id, timestamp)
        if (marked)
          insertMark.run(id, markId)
      }
      db.exec('COMMIT')
    }
    finally { db.close() }
  }, { databasePath: path.join(instance.home, 'buddy/buddy.sqlite3'), spaceId, markId, markedCount })
  await page.reload()
  const sidebar = page.locator('.desktop-task-sidebar')
  const viewport = sidebar.locator('.desktop-task-sidebar__spaces .v-vl')
  const markedIds = Array.from({ length: markedCount }, (_, index) => `quota-${10 + index}`)
  const ordinaryIds = Array.from({ length: 20 }, (_, index) => index)
    .filter(index => index < 10 || index >= 10 + markedCount)
    .map(index => `quota-${index}`)
  const initialOrdinary = Math.max(0, 5 - markedCount)
  await expect.poll(() => collectTaskIds(viewport)).toEqual([...markedIds, ...ordinaryIds.slice(0, initialOrdinary)].sort())
  await expect(sidebar.locator('.desktop-task-sidebar__pinned')).toHaveCount(0)
  await expect(sidebar.locator('.desktop-task-sidebar__section-heading')).toHaveText(['空间', '任务'])

  await page.evaluate(id => window.lexoraDesktop.settings.update({ desktop: { taskSidebarPinnedItems: [{ id, kind: 'space' }] } }), spaceId)
  const pinned = sidebar.locator('.desktop-task-sidebar__pinned')
  await expect(pinned).toBeVisible()
  await pinned.locator('.desktop-task-sidebar__section-toggle').click()
  await expect(pinned.locator('.desktop-task-sidebar__section-toggle')).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { taskSidebarPinnedItems: [] } }))
  await expect(pinned).toHaveCount(0)
  await expect.poll(() => collectTaskIds(viewport)).toEqual([...markedIds, ...ordinaryIds.slice(0, initialOrdinary)].sort())

  const more = await revealRow(viewport, `more:space:${spaceId}`)
  await more.getByRole('button', { name: '展开显示', exact: true }).click()
  await expect.poll(() => collectTaskIds(viewport)).toEqual([...markedIds, ...ordinaryIds.slice(0, initialOrdinary + 10)].sort())
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})
