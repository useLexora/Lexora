import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'

async function prepare(buddy, label) {
  const instance = await buddy.createInstance(label)
  const desktop = await instance.launch()
  await desktop.app.evaluate(({ BrowserWindow, ipcMain }, databasePath) => {
    BrowserWindow.getAllWindows()[0].setSize(2000, 1100)
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const now = new Date().toISOString()
      for (const id of ['a', 'b']) {
        db.prepare('INSERT INTO conversations (id, title, active_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, `Canvas ${id.toUpperCase()}`, `branch-${id}`, now, now)
        db.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(`branch-${id}`, id, now)
        db.prepare('INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`message-${id}`, id, `branch-${id}`, 'user', JSON.stringify({ text: `Question ${id.toUpperCase()}` }), now)
      }
    }
    finally { db.close() }
    const channel = 'lexora:buddy:conversations:get-tree'
    const handler = ipcMain._invokeHandlers.get(channel)
    const probe = globalThis.canvasProbe = { trees: {}, reads: {}, gate: null }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input) => {
      const id = input.conversationId
      probe.reads[id] = (probe.reads[id] ?? 0) + 1
      await probe.gate?.promise
      return probe.trees[id] ?? handler(event, input)
    })
  }, path.join(instance.home, 'buddy/buddy.sqlite3'))
  await desktop.page.reload()
  return { ...desktop, instance }
}

function task(page, id) {
  return page.locator(`[data-task-id="${id}"] .desktop-task-sidebar__task`)
}

function pane(page, title) {
  return page.locator('.workbench-pane').filter({ has: page.locator('.workbench-pane-title', { hasText: title }) })
}

async function readTree(page, id) {
  return page.evaluate(id => window.lexoraDesktop.localChat.conversations.getTree(id), id)
}

async function setTree(app, tree) {
  await app.evaluate((_electron, tree) => {
    globalThis.canvasProbe.trees[tree.conversationId] = tree
  }, tree)
}

async function refreshCanvas(pane) {
  await pane.getByTestId('conversation-canvas-toggle').click()
  await expect(pane.getByTestId('conversation-canvas')).toBeHidden()
  await pane.getByTestId('conversation-canvas-toggle').click()
  await expect(pane.getByTestId('conversation-canvas')).toBeVisible()
}

async function geometry(canvas, id) {
  return canvas.locator(`.conversation-canvas__graph [data-cell-id="${id}"]`).evaluate((element) => {
    const matrix = element.transform.baseVal.consolidate().matrix
    const fo = element.querySelector('foreignObject')
    return { x: matrix.e, y: matrix.f, width: Number(fo.getAttribute('width')), height: Number(fo.getAttribute('height')) }
  })
}

test('canvas actions, zoom and node lifetimes stay scoped across split panes and hidden views', async ({ buddy }) => {
  const { app, page, instance, diagnostics } = await prepare(buddy, 'canvas-panes')
  await task(page, 'a').click()
  const first = pane(page, 'Canvas A')
  await first.getByTestId('conversation-canvas-toggle').click()
  await expect(first.locator('.conversation-node')).toHaveCount(1)
  await first.getByTestId('pane-layout-menu').click()
  await page.locator('.n-dropdown-menu:visible').getByText('向右分屏', { exact: true }).click()
  await task(page, 'b').click()
  const second = pane(page, 'Canvas B')
  await second.getByTestId('conversation-canvas-toggle').click()
  await expect(second.locator('.conversation-node')).toHaveCount(1)
  await first.getByTestId('canvas-reset-zoom').click()
  await second.getByTestId('canvas-reset-zoom').click()
  for (let index = 0; index < 5; index++)
    await first.getByRole('button', { name: '缩小', exact: true }).click()
  await expect(first.locator('.conversation-node')).toHaveClass(/simplified/)
  await expect(second.locator('.conversation-node')).not.toHaveClass(/simplified/)
  await second.locator('.conversation-node').press('Enter')
  await expect(second.getByTestId('canvas-node-detail')).toHaveAttribute('data-target-id', 'message-b')
  await expect(first.getByTestId('canvas-node-detail')).toHaveCount(0)
  await second.getByTestId('canvas-node-detail').getByRole('button', { name: '关闭详情', exact: true }).click()
  await first.getByTestId('pane-layout-menu').click()
  await page.locator('.n-dropdown-menu:visible').getByText('关闭', { exact: true }).click()
  await expect(first).toHaveCount(0)
  await expect(second.locator('.conversation-node')).toContainText('Question B')
  await second.locator('.conversation-node').press('Enter')
  await expect(second.getByTestId('canvas-node-detail')).toHaveAttribute('data-target-id', 'message-b')
  await second.getByTestId('canvas-node-detail').getByRole('button', { name: '关闭详情', exact: true }).click()
  await second.getByTestId('canvas-minimap-toggle').click()
  await expect(second.getByTestId('canvas-minimap').locator('svg').first()).toBeVisible()
  const tree = await readTree(page, 'b')
  await page.getByTestId('context-panel-toggle').click()
  await page.getByTestId('context-panel-maximize').click()
  await expect(second.getByTestId('conversation-canvas')).toBeHidden()
  await expect(page.getByTestId('canvas-minimap').locator('svg')).toHaveCount(0)
  await setTree(app, { ...tree, nodes: tree.nodes.map(node => ({ ...node, text: 'Updated while hidden' })) })
  await page.getByTestId('context-panel-maximize').click()
  await expect(second.locator('.conversation-node')).toContainText('Updated while hidden')
  await expect(second.getByTestId('canvas-minimap').locator('svg').first()).toBeVisible()
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'canvas-restored.png'), animations: 'disabled' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

test('canvas commits resized branches after a held middle drag and keeps virtual rendering at every graph size', async ({ buddy }, testInfo) => {
  const { app, page, instance, diagnostics } = await prepare(buddy, 'canvas-geometry')
  const tree = await readTree(page, 'a')
  const root = tree.nodes[0]
  const answer = (id, parentId, text = id) => ({ ...root, id, parentId, kind: 'answer', messageId: null, runId: null, text, status: 'running', active: false })
  await setTree(app, { ...tree, nodes: [root, answer('left', root.id), answer('right', root.id)] })
  await task(page, 'a').click()
  const owner = pane(page, 'Canvas A')
  await owner.getByTestId('conversation-canvas-toggle').click()
  const canvas = owner.getByTestId('conversation-canvas')
  await expect(canvas.locator('.conversation-node')).toHaveCount(3)
  await canvas.getByTestId('canvas-minimap-toggle').click()
  const left = canvas.locator('[data-node-id="left"]')
  const before = await geometry(canvas, 'left')
  await app.evaluate(() => {
    globalThis.canvasProbe.gate = Promise.withResolvers()
  })
  await refreshCanvas(owner)
  const bounds = await canvas.boundingBox()
  await page.mouse.move(bounds.x + bounds.width - 12, bounds.y + bounds.height - 12)
  await page.mouse.down({ button: 'middle' })
  await expect(left).toHaveClass(/interacting/)
  await setTree(app, { ...tree, nodes: [root, { ...answer('left', root.id, 'Latest content'), status: 'failed', quoteCount: 1, artifactCount: 1 }, answer('right', root.id)] })
  await app.evaluate(() => {
    globalThis.canvasProbe.gate.resolve()
    globalThis.canvasProbe.gate = null
  })
  await expect(left).toHaveAttribute('data-status', 'failed')
  await expect(left).toContainText('Latest content')
  const started = Date.now()
  await expect.poll(() => Date.now() - started).toBeGreaterThan(250)
  await expect(left).toHaveClass(/interacting/)
  expect(await geometry(canvas, 'left')).toEqual(before)
  await page.mouse.up({ button: 'middle' })
  await expect(left).not.toHaveClass(/interacting/)
  await expect.poll(async () => (await geometry(canvas, 'left')).height).toBeGreaterThan(before.height)
  const after = await geometry(canvas, 'left')
  const right = await geometry(canvas, 'right')
  expect(right.y - after.y - after.height).toBeGreaterThanOrEqual(48)
  const rootBounds = await geometry(canvas, root.id)
  const start = await canvas.locator(`.conversation-canvas__graph [data-cell-id="edge:${root.id}:left"] path`).first().evaluate((element) => {
    const point = element.getPointAtLength(0)
    return { x: point.x, y: point.y }
  })
  expect(start.x).toBeCloseTo(rootBounds.x + rootBounds.width)
  expect(start.y).toBeCloseTo(rootBounds.y + rootBounds.height / 2)
  await expect(canvas.getByTestId('canvas-minimap').locator('foreignObject')).toHaveCount(0)
  await page.screenshot({ path: path.join(instance.artifactDirectory, 'canvas-resized.png'), animations: 'disabled' })

  const transform = () => canvas.locator('.conversation-canvas__graph .x6-graph-svg-viewport').getAttribute('transform')
  await canvas.getByTestId('canvas-layout-menu').click()
  await page.getByTestId('canvas-layout-vertical').click()
  await expect(canvas).toHaveAttribute('data-direction', 'vertical')
  await expect.poll(async () => (await geometry(canvas, 'left')).y).toBeGreaterThan((await geometry(canvas, root.id)).y)
  const verticalViewport = await transform()
  await canvas.getByTestId('canvas-layout-menu').click()
  await page.getByTestId('canvas-layout-horizontal').click()
  await expect.poll(transform).not.toBe(verticalViewport)
  await canvas.getByTestId('canvas-layout-menu').click()
  await page.getByTestId('canvas-layout-vertical').evaluate((button) => {
    button.click()
    document.querySelector('.conversation-canvas__graph').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 1, pointerId: 123 }))
  })
  await expect(left).toHaveClass(/interacting/)
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 123 })))
  await expect(left).not.toHaveClass(/interacting/)
  await expect.poll(transform).toBe(verticalViewport)
  await canvas.getByTestId('canvas-layout-menu').click()
  await page.getByTestId('canvas-layout-horizontal').click()
  await expect(canvas).toHaveAttribute('data-direction', 'horizontal')

  const samples = []
  for (const count of [300, 301, 1000]) {
    await setTree(app, { ...tree, nodes: [root, ...Array.from({ length: count - 1 }, (_, index) => ({ ...answer(`large-${index}`, index ? `large-${index - 1}` : root.id), status: 'completed' }))] })
    await refreshCanvas(owner)
    await expect(canvas.getByTestId('canvas-minimap').locator('.x6-node')).toHaveCount(count)
    await canvas.getByTestId('canvas-reset-zoom').click()
    await canvas.evaluate((element) => {
      const probe = window.canvasMountProbe = { maximum: 0, observer: null, frame: 0, intervals: [], longTasks: [] }
      let previous = performance.now()
      const sample = (time) => {
        probe.intervals.push(time - previous)
        previous = time
        probe.frame = requestAnimationFrame(sample)
      }
      probe.frame = requestAnimationFrame(sample)
      probe.performance = new PerformanceObserver(list => probe.longTasks.push(...list.getEntries().map(entry => entry.duration)))
      probe.performance.observe({ type: 'longtask' })
      const count = () => {
        probe.maximum = Math.max(probe.maximum, element.querySelectorAll('.conversation-node').length)
      }
      probe.observer = new MutationObserver(count)
      probe.observer.observe(element, { childList: true, subtree: true })
      count()
    })
    for (let cycle = 0; cycle < 5; cycle++) {
      if (cycle)
        await canvas.getByTestId('canvas-reset-zoom').click()
      for (let index = 0; index < 8; index++)
        await canvas.getByRole('button', { name: '缩小', exact: true }).click()
      await expect(canvas.getByTestId('canvas-reset-zoom')).toHaveText('20%')
      await expect(canvas.locator('.conversation-node.simplified').first()).toBeAttached()
      const bounds = await canvas.boundingBox()
      await page.mouse.move(bounds.x + bounds.width - 12, bounds.y + bounds.height - 12)
      await page.mouse.down({ button: 'middle' })
      await page.mouse.move(bounds.x + bounds.width - 300, bounds.y + bounds.height - 12, { steps: 15 })
      await page.mouse.move(bounds.x + bounds.width - 12, bounds.y + bounds.height - 12, { steps: 15 })
      await page.mouse.up({ button: 'middle' })
      await expect(canvas.locator('.conversation-node.interacting')).toHaveCount(0)
    }
    await expect.poll(() => canvas.evaluate((element) => {
      const graph = element.querySelector('.conversation-canvas__graph')
      const viewport = graph.querySelector('.x6-graph-svg-viewport').getScreenCTM()
      const bounds = graph.getBoundingClientRect()
      const mounted = new Set([...graph.querySelectorAll('.conversation-node')].map(node => node.dataset.nodeId))
      return [...element.querySelectorAll('.conversation-canvas__minimap .x6-node')].filter((node) => {
        const position = node.transform.baseVal.consolidate().matrix
        const point = new DOMPoint(position.e, position.f).matrixTransform(viewport)
        const rect = node.querySelector('rect')
        const width = rect.width.baseVal.value * viewport.a
        const height = rect.height.baseVal.value * viewport.d
        const visible = point.x < bounds.right && point.x + width > bounds.left && point.y < bounds.bottom && point.y + height > bounds.top
        return visible && !mounted.has(node.dataset.cellId)
      }).map(node => node.dataset.cellId)
    })).toEqual([])
    const metrics = await page.evaluate(() => {
      const probe = window.canvasMountProbe
      probe.observer.disconnect()
      probe.performance.disconnect()
      cancelAnimationFrame(probe.frame)
      const intervals = probe.intervals.slice(1).sort((a, b) => a - b)
      return {
        maximumMounted: probe.maximum,
        frames: intervals.length,
        frameIntervalP95: intervals[Math.floor(intervals.length * 0.95)],
        frameIntervalMax: Math.max(...intervals),
        longTasks: probe.longTasks,
      }
    })
    expect(metrics.maximumMounted).toBeLessThan(100)
    expect(metrics.maximumMounted).toBeGreaterThan(0)
    samples.push({ nodes: count, ...metrics })
    await canvas.getByTestId('canvas-reset-zoom').click()
    await expect(canvas.locator('.conversation-node:not(.simplified)').first()).toBeAttached()
  }
  await testInfo.attach('virtual-rendering', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})
